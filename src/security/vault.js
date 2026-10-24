import { aesKey, fromBase64, hmacSha256, open, pbkdf2, randomBytes, seal, toBase64 } from './crypto.js';

// The PIN never gets stored. What is stored (in the Android Keystore backed secret store):
//  - a random salt,
//  - a random device secret,
//  - the data key (DEK), encrypted with AES-GCM under  KEK = HMAC-SHA256(deviceSecret, PBKDF2(pin, salt)).
// To read the data an attacker needs the device's secret store AND the PIN. A wrong PIN fails the GCM check.
// Changing the PIN only re-wraps the DEK: the encrypted records are not touched.

export const FREE_ATTEMPTS = 5;

// Waiting time after the 5th, 6th, 7th ... wrong PIN (the last one repeats), in milliseconds.
export const DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 900_000];

const KEYS = { salt: 'v1.salt', device: 'v1.device', wrapped: 'v1.wrapped', iterations: 'v1.iter', fails: 'v1.fails', until: 'v1.until' };

export class Vault {
  // secrets: { get(key), set(key, value), remove(key), clear() }  (all async, string values)
  constructor(secrets, { iterations = 300_000, clock = () => Date.now() } = {}) {
    this.secrets = secrets;
    this.iterations = iterations;
    this.clock = clock;
  }

  // `wrapped` is written last, so a setup that was cut off half way counts as "not set up".
  async isSetUp() {
    return (await this.secrets.get(KEYS.wrapped)) !== null;
  }

  // Makes the keys for a new PIN and returns the data key as a CryptoKey (never as readable bytes).
  async setUp(pin) {
    const dek = randomBytes(32);
    await this.#wrap(pin, dek);
    await this.#resetFails();

    const key = await aesKey(dek);
    dek.fill(0);
    return key;
  }

  // -> { ok: true, key } | { ok: false, attemptsLeft, lockedForMs? }
  async unlock(pin) {
    const remaining = await this.lockRemainingMs();
    if (remaining > 0) return { ok: false, attemptsLeft: 0, lockedForMs: remaining };

    const dek = await this.#unwrap(pin);
    if (dek) {
      await this.#resetFails();
      const key = await aesKey(dek);
      dek.fill(0);
      return { ok: true, key };
    }

    const fails = (parseInt((await this.secrets.get(KEYS.fails)) ?? '0', 10) || 0) + 1;
    await this.secrets.set(KEYS.fails, String(fails));

    if (fails >= FREE_ATTEMPTS) {
      const wait = DELAYS_MS[Math.min(fails - FREE_ATTEMPTS, DELAYS_MS.length - 1)];
      await this.secrets.set(KEYS.until, String(this.clock() + wait));
      return { ok: false, attemptsLeft: 0, lockedForMs: wait };
    }

    return { ok: false, attemptsLeft: FREE_ATTEMPTS - fails };
  }

  // How long the keypad stays locked after too many wrong PINs (0 = entry is allowed).
  async lockRemainingMs() {
    const until = parseInt((await this.secrets.get(KEYS.until)) ?? '', 10);
    return Number.isFinite(until) ? Math.max(0, until - this.clock()) : 0;
  }

  // Needs the old PIN. Returns false when it is wrong (and that counts as a wrong attempt).
  async changePin(oldPin, newPin) {
    const remaining = await this.lockRemainingMs();
    if (remaining > 0) return false;

    const dek = await this.#unwrap(oldPin);
    if (!dek) {
      await this.unlock(oldPin); // records the wrong attempt
      return false;
    }

    await this.#wrap(newPin, dek);
    await this.#resetFails();
    dek.fill(0);
    return true;
  }

  // Removes every secret. The encrypted data can then never be read again.
  async erase() {
    await this.secrets.clear();
  }

  async #kek(pin, salt, device, iterations) {
    return aesKey(await hmacSha256(device, await pbkdf2(pin, salt, iterations)));
  }

  async #wrap(pin, dek) {
    const salt = randomBytes(16);
    const device = randomBytes(32);
    const sealed = await seal(await this.#kek(pin, salt, device, this.iterations), dek, 'dek');

    await this.secrets.set(KEYS.salt, toBase64(salt));
    await this.secrets.set(KEYS.device, toBase64(device));
    await this.secrets.set(KEYS.iterations, String(this.iterations));
    await this.secrets.set(KEYS.wrapped, toBase64(sealed)); // last on purpose
  }

  async #unwrap(pin) {
    const [salt, device, wrapped, iterations] = await Promise.all([
      this.secrets.get(KEYS.salt),
      this.secrets.get(KEYS.device),
      this.secrets.get(KEYS.wrapped),
      this.secrets.get(KEYS.iterations),
    ]);
    const rounds = parseInt(iterations ?? '', 10);
    if (!salt || !device || !wrapped || !Number.isFinite(rounds)) return null;

    try {
      const kek = await this.#kek(pin, fromBase64(salt), fromBase64(device), rounds);
      return await open(kek, fromBase64(wrapped), 'dek');
    } catch {
      return null; // wrong PIN, damaged value or changed device secret: all the same to the caller
    }
  }

  async #resetFails() {
    await this.secrets.remove(KEYS.fails);
    await this.secrets.remove(KEYS.until);
  }
}

// A secret store in memory, for tests.
export class MemorySecrets {
  constructor() {
    this.data = new Map();
  }
  async get(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }
  async set(key, value) {
    this.data.set(key, value);
  }
  async remove(key) {
    this.data.delete(key);
  }
  async clear() {
    this.data.clear();
  }
}
