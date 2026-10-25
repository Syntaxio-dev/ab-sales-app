import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { App } from '../src/app.js';
import { MemoryPersist } from '../src/data/persist.js';
import { ValidationError } from '../src/data/store.js';
import { MemorySecrets, Vault } from '../src/security/vault.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp, SyncError } from '../src/sync/http.js';
import { FakeOffice } from './helpers/fake-office.js';

// A new phone has no account of its own: only a rep the manager made on the website (code + password) can set the app up.

const BASE = 'https://office.example/api/sales/v1';
let office;
let calls;

function newApp({ linked = true } = {}) {
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const vault = new Vault(new MemorySecrets(), { iterations: 1000 });
  const persist = new MemoryPersist();
  const syncFactory = (store) => new SyncEngine({ store, http, appVersion: '2.0', deviceModel: 'Test phone', autoDelayMs: 15 });

  return new App({
    vault, persist, platform: { cleanExports: async () => {} }, syncFactory: linked ? syncFactory : null,
    officeLogin: linked ? (login, password) => { calls.push('login'); return http.post('/auth/login', { login, password }); } : null,
    officeLogout: linked ? (token) => { calls.push('logout'); return http.post('/auth/logout', {}, { token }); } : null,
  });
}

beforeEach(() => {
  office = new FakeOffice();
  office.addRep('REP001');
  calls = [];
});

test('the code and password the manager gave open the setup, and the name and code come from the office', async () => {
  const app = newApp();
  await app.init();
  assert.equal(app.phase, 'setup');

  const office1 = await app.signInToOffice(' rep001 ', 'secret-pass-1');
  assert.equal(office1.account.employee_code, 'REP001');
  assert.equal(office1.account.name, 'Rep REP001');
  assert.equal(app.phase, 'setup', 'nothing is set up until a PIN is chosen');

  await app.setUp({ pin: '483920', office: office1 });
  assert.equal(app.phase, 'unlocked');
  assert.deepEqual({ name: app.store.profile.name, code: app.store.profile.employee_code }, { name: 'Rep REP001', code: 'REP001' });
  assert.equal(app.sync.status.connected, true, 'the phone is linked to the office at once');
  assert.equal(app.sync.status.account.employee_code, 'REP001');
});

test('a wrong password or an unknown code does not get past the first screen', async () => {
  const app = newApp();
  await app.init();

  await assert.rejects(app.signInToOffice('REP001', 'not-the-password'), (e) => e instanceof SyncError);
  await assert.rejects(app.signInToOffice('HACK99', 'secret-pass-1'), (e) => e instanceof SyncError);
  assert.equal(app.phase, 'setup');
  assert.equal(await app.vault.isSetUp(), false, 'no keys were made');
});

test('an empty code or password is refused before anything is sent', async () => {
  const app = newApp();
  await app.init();

  await assert.rejects(app.signInToOffice('', 'x'), ValidationError);
  await assert.rejects(app.signInToOffice('REP001', ''), ValidationError);
  assert.deepEqual(calls, []);
});

test('a copy of the app without an office link cannot be set up', async () => {
  const app = newApp({ linked: false });
  await app.init();

  await assert.rejects(app.signInToOffice('REP001', 'secret-pass-1'), (e) => e instanceof ValidationError && /not linked/.test(e.message));
  assert.equal(app.phase, 'setup');
});

test('an answer from the office that does not look right is refused', async () => {
  const app = newApp();
  app.officeLogin = async () => ({ token: 'abc', account: { name: 'X', employee_code: '??' } });
  await assert.rejects(app.signInToOffice('REP001', 'secret-pass-1'), ValidationError);

  app.officeLogin = async () => ({ account: { name: 'Rep', employee_code: 'REP001' } });
  await assert.rejects(app.signInToOffice('REP001', 'secret-pass-1'), ValidationError);
});

test('going back from the PIN step signs the unused token out at the office', async () => {
  const app = newApp();
  await app.init();
  const signedIn = await app.signInToOffice('REP001', 'secret-pass-1');

  await app.discardOfficeSignIn(signedIn);
  assert.deepEqual(calls, ['login', 'logout']);
  assert.equal(app.phase, 'setup');

  // offline at that moment: nothing breaks
  app.officeLogout = async () => { throw new SyncError('NETWORK', 'offline'); };
  await app.discardOfficeSignIn(signedIn);
});

test('a weak PIN still stops the setup, and then nothing is stored', async () => {
  const app = newApp();
  await app.init();
  const signedIn = await app.signInToOffice('REP001', 'secret-pass-1');

  await assert.rejects(app.setUp({ pin: '123456', office: signedIn }), ValidationError);
  assert.equal(app.phase, 'setup');
  assert.equal(await app.vault.isSetUp(), false);
});
