import * as rules from './core/rules.js';
import { Store, ValidationError } from './data/store.js';

// What the screens see: which phase the app is in (loading, setup, locked, unlocked), the open store (only while
// unlocked), and the actions that change the phase. Locking closes the store, so the decrypted records are
// not kept in memory while the app is locked.

export const AUTO_LOCK_MS = 60_000;

export class App {
  phase = 'loading';
  store = null;

  // The camera / photo picker puts this app in the background on purpose; locking then would throw away a half-filled form.
  suspendAutoLock = false;

  #listeners = new Set();
  #wentToBackground = null;

  constructor({ vault, persist, platform, autoLockMs = AUTO_LOCK_MS, clock = () => Date.now() }) {
    this.vault = vault;
    this.persist = persist;
    this.platform = platform;
    this.autoLockMs = autoLockMs;
    this.clock = clock;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(phase) {
    this.phase = phase;
    for (const listener of [...this.#listeners]) listener(phase);
  }

  async init() {
    await this.platform.cleanExports?.();
    this.#set((await this.vault.isSetUp()) ? 'locked' : 'setup');
  }

  // First start: make the keys and save the rep's name and code.
  async setUp({ name, employeeCode, pin }) {
    const error = rules.firstError(rules.pin(pin), rules.required(name, { min: 2, max: 100, label: 'Name' }), rules.employeeCode(employeeCode));
    if (error) throw new ValidationError(error);

    const key = await this.vault.setUp(pin);
    const store = await Store.open(this.persist, key);
    await store.saveProfile({ name, employeeCode });

    this.store = store;
    this.#set('unlocked');
  }

  // -> { ok: true } | { ok: false, attemptsLeft, lockedForMs? }
  async unlock(pin) {
    const result = await this.vault.unlock(pin);
    if (!result.ok) return result;

    this.store = await Store.open(this.persist, result.key);
    this.#set('unlocked');
    return { ok: true };
  }

  async lock() {
    if (this.phase !== 'unlocked') return;

    const store = this.store;
    this.store = null;
    this.#set('locked'); // screens leave the data first, then the records are dropped from memory
    await store?.close();
    await this.platform.cleanExports?.();
  }

  // Returns false when the old PIN is wrong (that also counts as a wrong attempt in the vault).
  async changePin(oldPin, newPin) {
    const error = rules.pin(newPin);
    if (error) throw new ValidationError(error);
    return this.vault.changePin(oldPin, newPin);
  }

  // Deletes every record, photo and key. Also the only way out when the PIN is forgotten.
  async eraseEverything() {
    const store = this.store;
    this.store = null;
    await store?.close();
    await this.persist.clear();
    await this.vault.erase();
    await this.platform.cleanExports?.();
    this.#set('setup');
  }

  // ---- auto lock ------------------------------------------------------------

  goneToBackground() {
    this.#wentToBackground ??= this.clock();
  }

  backInForeground() {
    const since = this.#wentToBackground;
    this.#wentToBackground = null;

    if (!this.suspendAutoLock && since !== null && this.clock() - since >= this.autoLockMs) this.lock();
  }
}
