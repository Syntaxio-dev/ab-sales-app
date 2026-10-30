import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { App } from '../src/app.js';
import { callId, directionOf, matchCalls } from '../src/calls/matcher.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanCall, cleanContact } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

const BASE = 'https://office.example/api/sales/v1';
let office;
let key;

async function phone({ code = 'REP001', persist = new MemoryPersist() } = {}) {
  const store = await Store.open(persist, key);
  if (!store.profile) await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '2.0', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine, persist };
}

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

// ---- the shared pool ---------------------------------------------------------------------

test('a client and a person one rep adds reach the other rep, with who added it', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });

  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement', city: 'Nimbahera' });
  await a.store.saveContact({ client_id: client.id, name: 'Rohit Sharma', position: 'Purchase Manager', phone: '98765 43210' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  assert.equal(b.store.clients.length, 1);
  assert.equal(b.store.clients[0].created_by_code, 'REP001');
  assert.equal(b.store.clients[0].assigned_to_code, 'REP001');
  assert.equal(b.store.contactsOf(client.id).length, 1);
  assert.equal(b.store.contactsOf(client.id)[0].phone, '+919876543210');
});

test('the rep who added a client improves it; the other rep can only read it', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  assert.equal(a.store.canEdit(a.store.clientById(client.id)), true);
  assert.equal(b.store.canEdit(b.store.clientById(client.id)), false);

  // the phone itself refuses (the screen shows it read only) ...
  await assert.rejects(() => b.store.saveClient({ lat: 26.9124, lng: 75.7873, id: client.id, name: 'JK Cement', city: 'Hacked' }), ValidationError);
  assert.equal(b.store.clientById(client.id).city, '');

  // ... and the owner's change reaches the other rep
  await new Promise((r) => setTimeout(r, 5));
  await a.store.saveClient({ lat: 26.9124, lng: 75.7873, id: client.id, name: 'JK Cement', city: 'Nimbahera', notes: 'Ask for Rohit' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  assert.equal(b.store.clientById(client.id).city, 'Nimbahera');
  assert.equal(b.store.clientById(client.id).notes, 'Ask for Rohit');
  assert.equal(b.store.clientById(client.id).created_by_code, 'REP001', 'who added it does not change');
});

test('the office refuses a change to a record somebody else added, and the phone gets the real copy back', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  // an older app, or a hand-made push (the store itself would refuse): rep 2 sends a change to rep 1's client
  await new Promise((r) => setTimeout(r, 5));
  const res = office.push(2, { clients: [{ uuid: client.id, name: 'Hacked', updated_at: new Date(Date.now() + 1000).toISOString() }], deleted: {} });
  const json = await res.json();
  assert.equal(json.results.clients[0].status, 'rejected');
  assert.equal(json.results.clients[0].code, 'NOT_ALLOWED');

  await a.engine.syncNow();
  assert.equal(a.store.clientById(client.id).name, 'JK Cement');
});

test('a person can be saved without a company, and everybody sees who added them', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });

  const alone = await a.store.saveContact({ client_id: null, name: 'Meena Joshi', phone: '98290 11223' });
  assert.equal(alone.client_id, null);
  assert.deepEqual(a.store.loosePeople.map((p) => p.name), ['Meena Joshi']);
  assert.equal(a.store.addedBy(alone), 'You');

  await a.engine.syncNow();
  await b.engine.syncNow();

  const seen = b.store.loosePeople;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].client_id, null);
  assert.equal(seen[0].created_by_code, 'REP001');
  assert.equal(seen[0].created_by_name, 'Rep REP001');
  assert.equal(b.store.addedBy(seen[0]), 'Rep REP001');
  assert.equal(b.store.canEdit(seen[0]), false);
  await assert.rejects(() => b.store.saveContact({ id: seen[0].id, client_id: null, name: 'Meena J' }), ValidationError);

  // her number is in the pool: a call with it is matched, with no company name
  const { matched } = await matchCalls([{ number: '9829011223', type: 2, date: Date.now(), duration: 60 }], b.store, 'REP002');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].client_id, null);
  assert.equal(matched[0].client_name, '');
  assert.equal(matched[0].contact_name, 'Meena Joshi');
  assert.match(b.store.numberOwner('+919829011223'), /^Meena Joshi$/);
});

test('a person can be added to somebody else\'s client, and stays that rep\'s own', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  const mine = await b.store.saveContact({ client_id: client.id, name: 'Rohit Sharma', phone: '98765 43210' });
  await b.engine.syncNow();
  await a.engine.syncNow();

  const onA = a.store.contactById(mine.id);
  assert.equal(onA.created_by_name, 'Rep REP002');
  assert.equal(a.store.canEdit(onA), false);
  assert.equal(b.store.canEdit(b.store.contactById(mine.id)), true);
  assert.equal(a.store.contactsOf(client.id).length, 1);
});

test('who works a client is the office\'s decision and comes down to the phone', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  await a.engine.syncNow();

  office.assign(client.id, 'REP002');
  await b.engine.syncNow();
  assert.equal(b.store.clientById(client.id).assigned_to_code, 'REP002');

  // an edit from rep 1 afterwards cannot take the client back
  await new Promise((r) => setTimeout(r, 5));
  await a.engine.syncNow();
  await a.store.saveClient({ lat: 26.9124, lng: 75.7873, id: client.id, name: 'JK Cement Ltd' });
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(b.store.clientById(client.id).assigned_to_code, 'REP002');
});

test('only the one who added a client can delete it; the people go with it; the others keep what is not theirs', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  const person = await a.store.saveContact({ client_id: client.id, name: 'Rohit Sharma', phone: '98765 43210' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  assert.equal(b.store.canDelete(b.store.clientById(client.id)), false);
  assert.equal(a.store.canDelete(a.store.clientById(client.id)), true);

  // even if a phone tries, the office refuses and the phone gets the record back
  await b.store.deleteClient(client.id);
  assert.equal(b.store.clients.length, 0);
  await b.engine.syncNow();
  assert.equal(b.store.clients.length, 1, 'the office kept it and the phone took it back');
  assert.equal(b.store.contactsOf(client.id).length, 1);
  assert.equal(b.store.unsyncedCount, 0);

  await a.store.deleteClient(client.id);
  assert.equal(a.store.contactById(person.id), null, 'the person goes with the client');
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(b.store.clients.length, 0);
  assert.equal(b.store.contacts.length, 0);
});

// ---- people, numbers and positions ----------------------------------------------------------

test('a number can be saved once in the whole pool', async () => {
  const { store } = await phone();
  const one = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  const two = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Shree Cement' });
  const person = await store.saveContact({ client_id: one.id, name: 'Rohit', phone: '98765 43210' });

  await assert.rejects(store.saveContact({ client_id: two.id, name: 'Copy', phone: '+91 98765-43210' }), (e) => e instanceof ValidationError && /already saved under Rohit \(JK Cement\)/.test(e.message));
  await assert.rejects(store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Third', phone: '9876543210' }).then((c) => store.saveContact({ client_id: c.id, name: 'Again', phone: '9876543210' })), ValidationError);

  // editing the same person keeps their own number
  await store.saveContact({ id: person.id, client_id: one.id, name: 'Rohit Sharma', phone: '98765 43210' });
  assert.equal(store.contacts.find((c) => c.id === person.id).name, 'Rohit Sharma');
});

test('a new position is added once, sent to the office, and everybody gets the list', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });

  assert.ok(a.store.positions.includes('Purchase Manager'), 'the built-in list is there before any sync');
  await a.store.addPosition('Plant  Chemist');
  await a.store.addPosition('plant chemist'); // the same one
  assert.equal(a.store.pendingPositions.length, 1);
  assert.equal(a.store.positions.filter((p) => /plant chemist/i.test(p)).length, 1);
  await assert.rejects(a.store.addPosition('<b>'), ValidationError);

  await a.engine.syncNow();
  assert.equal(a.store.pendingPositions.length, 0);
  await b.engine.syncNow();
  assert.ok(b.store.positions.includes('Plant Chemist'));
});

test('a person with a new position teaches the list too', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  await a.store.saveContact({ client_id: client.id, name: 'Anita', position: 'R&D Head' });
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.ok(b.store.positions.includes('R&D Head'));
});

test('a meeting remembers the people met, and they come back on a new phone', async () => {
  const a = await phone({ code: 'REP001' });
  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  const p1 = await a.store.saveContact({ client_id: client.id, name: 'Rohit Sharma', phone: '98765 43210' });
  const p2 = await a.store.saveContact({ client_id: client.id, name: 'Anita Gupta', phone: '91234 56789' });
  const meeting = await a.store.saveMeeting({ client_id: client.id, client_name: 'JK Cement', contact_ids: [p1.id, p2.id, p1.id], meeting_at: new Date().toISOString() });
  assert.deepEqual(meeting.contact_ids, [p1.id, p2.id]);
  await a.engine.syncNow();

  const again = await phone({ code: 'REP001' }); // a fresh phone, same rep
  await again.engine.syncNow();
  assert.deepEqual(again.store.meetings[0].contact_ids.sort(), [p1.id, p2.id].sort());
});

// ---- calls ---------------------------------------------------------------------------------------

const row = (number, type, minutesAgo, duration = 60) => ({ number, type, date: Date.now() - minutesAgo * 60_000, duration });

test('only calls with a saved client number are kept; every other call is dropped', async () => {
  const { store } = await phone();
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  const rohit = await store.saveContact({ client_id: client.id, name: 'Rohit Sharma', position: 'Purchase Manager', phone: '98765 43210' });

  const { matched, unknown } = await matchCalls([
    row('+919876543210', 2, 10, 95),          // outgoing to Rohit
    row('09876543210', 1, 30, 20),             // incoming from Rohit, other spelling
    row('9876543210', 3, 50),                  // missed
    row('9811122233', 2, 5),                   // a friend: not in the pool
    row('9811122233', 1, 8),
    row('1800 123 456', 2, 3),                 // a short / toll free code
    row('', 1, 2),                             // hidden number
    row('+919876543210', 4, 1),                // voicemail: skipped
  ], store, 'REP001');

  assert.equal(matched.length, 3);
  assert.deepEqual(matched.map((m) => m.direction), ['outgoing', 'incoming', 'missed']);
  assert.ok(matched.every((m) => m.client_name === 'JK Cement' && m.contact_name === 'Rohit Sharma' && m.contact_id === rohit.id));
  assert.equal(matched[0].duration_seconds, 95);
  assert.equal(matched[2].duration_seconds, 0, 'a missed call has no length');

  // the friend is only an "unknown number" for the screen, in memory
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].number, '+919811122233');
  assert.equal(unknown[0].count, 2);
});

test('the same call always has the same id, so importing twice never doubles it', async () => {
  const { store } = await phone();
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement', phone: '98765 43210' });
  const log = [row('9876543210', 2, 10, 95)];

  const first = await matchCalls(log, store, 'REP001');
  const second = await matchCalls(log, store, 'REP001');
  assert.equal(first.matched[0].id, second.matched[0].id);
  assert.match(first.matched[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(await callId('REP002', '+919876543210', 1, 'outgoing'), await callId('REP001', '+919876543210', 1, 'outgoing'));
  assert.equal(first.matched[0].client_id, client.id, 'the client main number matches too');

  assert.equal(await store.saveCalls(first.matched), 1);
  assert.equal(await store.saveCalls(second.matched), 0);
  assert.equal(store.calls.length, 1);
  assert.equal(directionOf(5), 'missed');
  assert.equal(directionOf(4), null);
});

test('calls are sent once, stay with their rep, and come back on a new phone', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const client = await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement', phone: '98765 43210' });
  await a.store.saveCalls((await matchCalls([row('9876543210', 2, 10, 95)], a.store, 'REP001')).matched);

  await a.engine.syncNow();
  assert.equal(a.store.unsyncedCount, 0);
  assert.equal(office.count('calls'), 1);
  assert.equal(a.engine.status.refused.length, 0);

  await b.engine.syncNow();
  assert.equal(b.store.calls.length, 0, 'another rep never gets them');

  const again = await phone({ code: 'REP001' });
  await again.engine.syncNow();
  assert.equal(again.store.calls.length, 1);
  assert.equal(again.store.calls[0].client_id, client.id);
});

test('what the office sends for people and calls is checked like everything else', () => {
  assert.equal(cleanContact({ uuid: 'x', client_uuid: 'y', name: 'A' }), null);
  assert.equal(cleanContact({ uuid: crypto.randomUUID(), client_uuid: crypto.randomUUID(), name: 'Rohit', phone: '98765 43210', updated_at: new Date().toISOString() }).phone, '+919876543210');
  assert.equal(cleanCall({ uuid: crypto.randomUUID(), direction: 'conference', number: '+919876543210', started_at: new Date().toISOString(), duration_seconds: 5 }), null);
  assert.equal(cleanCall({ uuid: crypto.randomUUID(), direction: 'incoming', number: '9876543210', started_at: new Date().toISOString(), duration_seconds: 5 }), null);
  assert.equal(cleanCall({ uuid: crypto.randomUUID(), direction: 'incoming', number: '+919876543210', started_at: new Date().toISOString(), duration_seconds: -3 }), null);
});

// ---- another rep on the same phone -----------------------------------------------------------------

function appOn(persist, platformExtra = {}) {
  const vaultStub = { isSetUp: async () => true, unlock: async () => ({ ok: true, key }), setUp: async () => key, erase: async () => {} };
  const syncFactory = (store) => new SyncEngine({ store, http: createHttp({ base: BASE, fetchFn: (...a) => office.fetch(...a) }), appVersion: '2.0', deviceModel: 't', autoDelayMs: 15 });
  return new App({ vault: vaultStub, persist, platform: { cleanExports: async () => {}, ...platformExtra }, syncFactory });
}

test('switching account wipes the phone for the next rep, but only after everything was sent (or the person agrees)', async () => {
  const app = appOn(new MemoryPersist());
  await app.unlock('483920');
  await app.store.saveProfile({ name: 'Rep REP001', employeeCode: 'REP001' });
  await app.sync.connect({ login: 'REP001', password: 'secret-pass-1' });

  await app.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement' });
  await assert.rejects(app.switchAccount(), (e) => e instanceof ValidationError && /not sent/.test(e.message));
  assert.equal(app.store.clients.length, 1, 'nothing was lost by the refusal');

  await app.sync.syncNow();
  await app.switchAccount();

  assert.equal(app.store.clients.length, 0);
  assert.equal(app.store.profile, null);
  assert.equal(app.sync.status.connected, false);
  assert.equal(office.count('clients'), 1, 'the office still has it');

  // the next rep signs in and gets the shared pool
  await app.sync.connect({ login: 'REP002', password: 'secret-pass-1' });
  await app.store.saveProfile({ name: 'Rep REP002', employeeCode: 'REP002' });
  await app.sync.syncNow();
  assert.equal(app.store.clients.length, 1);
  assert.equal(app.store.profile.employee_code, 'REP002');
});

test('switching anyway (the person agreed to lose unsent changes) wipes even then', async () => {
  const app = appOn(new MemoryPersist());
  await app.unlock('483920');
  await app.store.saveProfile({ name: 'Rep REP001', employeeCode: 'REP001' });
  await app.sync.connect({ login: 'REP001', password: 'secret-pass-1' });
  await app.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Unsent' });

  await app.switchAccount({ discard: true });

  assert.equal(app.store.clients.length, 0);
  assert.equal(office.count('clients'), 0);
});

// ---- call matching switch in the app ------------------------------------------------------------------

test('a phone that held a sync cursor from before the pool still gets every shared client once', async () => {
  const b = await phone({ code: 'REP002' });
  await b.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Old Co' });
  await b.engine.syncNow();

  const a = await phone({ code: 'REP001' });
  // what a v1.3 phone looks like: a cursor that is past everything in the pool, and no "pool_v2" mark
  await a.store.saveSyncState({ cursor: String(office.rev + 1000), pool_v2: false });
  await a.engine.syncNow();

  assert.equal(a.store.clients.length, 1, 'the older client reached it');
  assert.equal(a.store.syncState.pool_v2, true);
});

test('a sync that is still running when the rep is switched writes nothing into the cleared phone', async () => {
  const b = await phone({ code: 'REP002' });
  await b.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Shared Co' });
  await b.store.saveExpense({ category: 'fuel', bill_type: 'without_bill', work_area: 'local', amount_paise: 500, expense_date: new Date().toISOString().slice(0, 10) });
  await b.engine.syncNow();

  const app = appOn(new MemoryPersist());
  await app.unlock('483920');
  await app.store.saveProfile({ name: 'Rep REP002', employeeCode: 'REP002' });

  // the answer to the pull comes back slowly
  const original = office.fetch;
  office.fetch = async (url, init) => {
    const answer = await original(url, init);
    if (String(url).includes('/sync/pull')) await new Promise((r) => setTimeout(r, 60));
    return answer;
  };
  await app.sync.connect({ login: 'REP002', password: 'secret-pass-1' });
  const running = app.sync.syncNow();
  await new Promise((r) => setTimeout(r, 10));

  await app.switchAccount({ discard: true });
  await running;

  assert.equal(app.store.clients.length, 0);
  assert.equal(app.store.expenses.length, 0);
  assert.equal(app.store.profile, null);
});

test('call matching is off until the person turns it on, and then only matched calls are kept', async () => {
  let permission = 'prompt';
  const log = [row('9876543210', 2, 10, 95), row('9811122233', 2, 5)];
  const callLog = {
    available: true,
    status: async () => permission,
    request: async () => (permission = 'granted'),
    recent: async () => log,
  };
  const app = appOn(new MemoryPersist(), { callLog });
  await app.unlock('483920');
  await app.store.saveProfile({ name: 'Rep REP001', employeeCode: 'REP001' });
  await app.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement', phone: '98765 43210' });

  assert.equal(await app.callMatchingState(), 'off');
  assert.deepEqual(await app.refreshCalls(), { added: 0 }, 'nothing is read while it is off');
  assert.equal(app.store.calls.length, 0);

  assert.equal(await app.enableCallMatching(), 'on');
  assert.equal(app.store.calls.length, 1);
  assert.equal(app.unknownCalls.length, 1);
  assert.equal(app.unknownCalls[0].number, '+919811122233');

  await app.lock();
  assert.deepEqual(app.unknownCalls, [], 'personal numbers do not stay in memory when the app locks');
});

test('a refusal from Android leaves call matching off', async () => {
  const app = appOn(new MemoryPersist(), { callLog: { available: true, status: async () => 'denied', request: async () => 'denied', recent: async () => [] } });
  await app.unlock('483920');

  assert.equal(await app.enableCallMatching(), 'denied');
  assert.equal(await app.callMatchingState(), 'off');
});
