import { LOOKBACK_DAYS, MAX_ROWS, matchCalls } from './calls/matcher.js';
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

  // The office link (src/sync/engine.js) exists only while the app is unlocked and an office server is configured.
  sync = null;

  // Numbers in the call history that are NOT in the client pool (so the rep can save one as a new client). Memory only: never
  // stored, never sent, gone when the app locks.
  unknownCalls = [];
  #callsBusy = false;

  constructor({ vault, persist, platform, syncFactory = null, autoLockMs = AUTO_LOCK_MS, clock = () => Date.now() }) {
    this.syncFactory = syncFactory;
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
    this.#startSync();
    this.#set('unlocked');
  }

  // -> { ok: true } | { ok: false, attemptsLeft, lockedForMs? }
  async unlock(pin) {
    const result = await this.vault.unlock(pin);
    if (!result.ok) return result;

    this.store = await Store.open(this.persist, result.key);
    this.#startSync();
    this.#set('unlocked');
    this.sync?.schedule(800); // catch up with the office as soon as the app is open
    void this.refreshCalls();
    return { ok: true };
  }

  async lock() {
    if (this.phase !== 'unlocked') return;

    const store = this.store;
    this.store = null;
    this.#stopSync();
    this.unknownCalls = [];
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
    this.#stopSync();
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
    else if (this.phase === 'unlocked') {
      this.sync?.schedule(1500); // back from the background: catch up
      void this.refreshCalls();
    }
  }

  // ---- call matching (Calls tab) -----------------------------------------------------------

  // 'off' (not turned on, or no call history on this device) | 'denied' (Android says no) | 'on'
  async callMatchingState() {
    const log = this.platform.callLog;
    if (!log?.available || !this.store) return 'off';
    if (this.store.prefs.call_matching !== true) return 'off';

    return (await log.status().catch(() => 'denied')) === 'granted' ? 'on' : 'denied';
  }

  // The person agreed (the screen explained what is read and what is kept) and Android asks for its permission.
  async enableCallMatching() {
    const log = this.platform.callLog;
    if (!log?.available || !this.store) return 'off';

    this.suspendAutoLock = true; // Android's permission dialog puts this app in the background for a moment
    try {
      const state = (await log.request().catch(() => 'denied'));
      if (state !== 'granted') return 'denied';
    } finally {
      this.suspendAutoLock = false;
    }

    await this.store.savePrefs({ call_matching: true });
    await this.refreshCalls();
    return 'on';
  }

  async disableCallMatching() {
    await this.store?.savePrefs({ call_matching: false });
    this.unknownCalls = [];
  }

  // Reads the last 30 days of the call history, keeps the calls with a saved client number (they join the next sync) and remembers,
  // in memory only, the other numbers. Safe to call as often as needed: a call already known is skipped.
  async refreshCalls() {
    const log = this.platform.callLog;
    const store = this.store;
    if (!log?.available || !store || this.#callsBusy || store.prefs.call_matching !== true) return { added: 0 };

    this.#callsBusy = true;
    try {
      if ((await log.status()) !== 'granted') return { added: 0 };

      const rows = await log.recent({ sinceMs: this.clock() - LOOKBACK_DAYS * 86_400_000, limit: MAX_ROWS });
      const { matched, unknown } = await matchCalls(rows, store, store.profile?.employee_code ?? 'UNKNOWN');
      if (this.store === store) this.unknownCalls = unknown; // before the save: a save redraws the screen
      const added = await store.saveCalls(matched);
      if (added) this.sync?.schedule();

      return { added };
    } catch {
      return { added: 0 }; // the call history is a convenience: a failure here never stops the app
    } finally {
      this.#callsBusy = false;
    }
  }

  // ---- another rep on the same phone --------------------------------------------------------

  // Gets the phone ready for another rep: signs out of the office and erases the records (the PIN stays). What the office already has
  // comes back when the new rep signs in. Records that were never sent are lost, so they must be sent first, or the person must
  // agree to lose them ({ discard: true }).
  async switchAccount({ discard = false } = {}) {
    const store = this.store;
    if (!store || this.phase !== 'unlocked') return;

    if (!discard && store.unsyncedCount > 0) {
      throw new ValidationError(`${store.unsyncedCount} changes were not sent to the office yet. Sync first (or switch anyway and lose them).`);
    }

    // stop first: a sync that is already on its way may finish, but it writes nothing any more; then wait for it, then sign out and wipe
    const engine = this.sync;
    this.#stopSync();
    await engine?.whenIdle();
    await engine?.signOut();
    await store.wipeEverything();
    this.unknownCalls = [];
    this.#startSync();
  }

  #startSync() {
    this.sync = this.syncFactory ? this.syncFactory(this.store) : null;
    this.sync?.start();
  }

  #stopSync() {
    this.sync?.stop();
    this.sync = null;
  }
}
