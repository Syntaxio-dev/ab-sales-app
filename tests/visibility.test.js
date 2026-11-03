import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { MemoryPersist } from '../src/data/persist.js';
import { Store } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { FakeOffice } from './helpers/fake-office.js';

// v1.10: a rep sees only their own clients and people, plus the clients the manager opens for them (and all the people at those).

const BASE = 'https://office.example/api/sales/v1';
const JAIPUR = { lat: 26.9124, lng: 75.7873, city: 'Jaipur' };
let office;
let key;

beforeEach(async () => {
  office = new FakeOffice();
  office.restrictPool = true;
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

async function phone(code) {
  const store = await Store.open(new MemoryPersist(), key);
  await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '1.10', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine };
}

const names = (store) => store.clients.map((c) => c.name).sort();

test('a rep sees their own clients and people only', async () => {
  const a = await phone('REP001');
  const b = await phone('REP002');
  const jk = await a.store.saveClient({ name: 'JK Cement', ...JAIPUR });
  await a.store.saveContact({ client_id: jk.id, name: 'Rohit', phone: '98765 43210' });
  await b.store.saveClient({ name: 'Ultratech', ...JAIPUR });

  await a.engine.syncNow();
  await b.engine.syncNow();
  await a.engine.syncNow();

  assert.deepEqual(names(a.store), ['JK Cement']);
  assert.deepEqual(names(b.store), ['Ultratech']);
  assert.equal(b.store.contacts.length, 0, 'the people of a client B cannot see stay hidden');
});

test('the manager opens a client for a rep: it comes with all its people; closing it takes it away again', async () => {
  const a = await phone('REP001');
  const b = await phone('REP002');
  const iit = await a.store.saveClient({ name: 'IIT Jodhpur', ...JAIPUR });
  await a.store.saveContact({ client_id: iit.id, name: 'Prof One', phone: '98765 43210' });
  await a.store.saveContact({ client_id: iit.id, name: 'Prof Two', phone: '98765 43211' });
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.deepEqual(names(b.store), []);

  office.open(iit.id, 2);
  await b.engine.syncNow();
  assert.deepEqual(names(b.store), ['IIT Jodhpur']);
  assert.equal(b.store.contacts.length, 2, 'all the teachers come with the client');

  office.close(iit.id, 2);
  await b.engine.syncNow();
  assert.deepEqual(names(b.store), [], 'closed: it disappears from the phone');
  assert.equal(b.store.contacts.length, 0);
});

test('what is still waiting to be sent is not dropped when the list shrinks', async () => {
  const a = await phone('REP001');
  const b = await phone('REP002');
  const jk = await a.store.saveClient({ name: 'JK Cement', ...JAIPUR });
  await a.engine.syncNow();
  office.open(jk.id, 2);
  await b.engine.syncNow();
  assert.deepEqual(names(b.store), ['JK Cement']);

  const own = await b.store.saveClient({ name: 'Own Co', ...JAIPUR }); // not sent yet
  office.close(jk.id, 2);
  office.fetchWillFailOnce = false;
  await b.engine.syncNow();

  assert.ok(b.store.clientById(own.id), 'a client of this rep stays');
  assert.equal(b.store.clientById(jk.id), null);
});

test('an office that does not restrict anything (older) leaves the list alone', async () => {
  office.restrictPool = false;
  const a = await phone('REP001');
  const b = await phone('REP002');
  await a.store.saveClient({ name: 'JK Cement', ...JAIPUR });
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.deepEqual(names(b.store), ['JK Cement']);
});
