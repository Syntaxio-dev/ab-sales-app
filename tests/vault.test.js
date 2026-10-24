import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { DELAYS_MS, MemorySecrets, Vault } from '../src/security/vault.js';

let secrets;
let now;
let vault;

beforeEach(() => {
  secrets = new MemorySecrets();
  now = 1_000_000;
  vault = new Vault(secrets, { iterations: 1000, clock: () => now }); // few rounds: the tests must be fast
});

// two keys are "the same" when one can open what the other sealed
async function sameKey(a, b) {
  const iv = new Uint8Array(12);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a, new Uint8Array([1, 2, 3]));
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b, sealed));
  return plain.join() === '1,2,3';
}

test('not set up until setUp has run', async () => {
  assert.equal(await vault.isSetUp(), false);
  await vault.setUp('483920');
  assert.equal(await vault.isSetUp(), true);
});

test('the right PIN gives back the same data key every time', async () => {
  const key = await vault.setUp('483920');
  const first = await vault.unlock('483920');
  const second = await vault.unlock('483920');

  assert.equal(first.ok, true);
  assert.ok(await sameKey(key, first.key));
  assert.ok(await sameKey(key, second.key));
});

test('the data key can only encrypt and decrypt: it cannot be exported', async () => {
  const key = await vault.setUp('483920');
  await assert.rejects(crypto.subtle.exportKey('raw', key));
});

test('neither the PIN nor the key is stored in plain form', async () => {
  await vault.setUp('483920');
  const stored = [...secrets.data.values()].join('|');
  assert.ok(!stored.includes('483920'));
});

test('a wrong PIN gives no key and counts down the free attempts', async () => {
  await vault.setUp('483920');

  assert.deepEqual(await vault.unlock('111222'), { ok: false, attemptsLeft: 4 });
  assert.equal((await vault.unlock('111222')).attemptsLeft, 3);

  assert.equal((await vault.unlock('483920')).ok, true); // a right PIN resets the counter
  assert.equal((await vault.unlock('111222')).attemptsLeft, 4);
});

test('five wrong PINs lock the keypad, and the right PIN is refused while locked', async () => {
  await vault.setUp('483920');
  for (let i = 0; i < 4; i++) assert.equal((await vault.unlock('000111')).lockedForMs, undefined);

  assert.equal((await vault.unlock('000111')).lockedForMs, 30_000);

  const locked = await vault.unlock('483920');
  assert.equal(locked.ok, false);
  assert.ok(locked.lockedForMs > 0);

  now += 31_000;
  assert.equal((await vault.unlock('483920')).ok, true);
});

test('waiting time grows with every further wrong PIN', async () => {
  await vault.setUp('483920');
  const waits = [];

  for (let i = 0; i < 9; i++) {
    const result = await vault.unlock('000111');
    if (result.lockedForMs) waits.push(result.lockedForMs);
    now += 3_600_000; // let each lock expire
  }

  assert.deepEqual(waits, DELAYS_MS);
});

test('the lock survives a restart (it is kept in storage, not in memory)', async () => {
  await vault.setUp('483920');
  for (let i = 0; i < 5; i++) await vault.unlock('000111');

  const restarted = new Vault(secrets, { iterations: 1000, clock: () => now });
  assert.ok((await restarted.lockRemainingMs()) > 0);
});

test('changePin needs the old PIN and keeps the same data key', async () => {
  const key = await vault.setUp('483920');

  assert.equal(await vault.changePin('000111', '729104'), false);
  assert.equal(await vault.changePin('483920', '729104'), true);

  assert.equal((await vault.unlock('483920')).ok, false);
  assert.ok(await sameKey(key, (await vault.unlock('729104')).key));
});

test('a wrong old PIN in changePin counts as a wrong attempt', async () => {
  await vault.setUp('483920');
  for (let i = 0; i < 5; i++) await vault.changePin('000111', '729104');

  assert.ok((await vault.lockRemainingMs()) > 0);
});

test('without the device secret even the right PIN cannot open the data', async () => {
  await vault.setUp('483920');
  secrets.data.set('v1.device', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');

  assert.equal((await vault.unlock('483920')).ok, false);
});

test('damaged stored values fail safely instead of crashing', async () => {
  await vault.setUp('483920');
  secrets.data.set('v1.wrapped', 'not base64 !!!');

  assert.equal((await vault.unlock('483920')).ok, false);
});

test('erase removes every secret', async () => {
  await vault.setUp('483920');
  await vault.erase();

  assert.equal(await vault.isSetUp(), false);
  assert.equal(secrets.data.size, 0);
});
