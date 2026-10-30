import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { MemoryPersist } from '../src/data/persist.js';
import { Store } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { SyncError, assertSecureBase, createHttp } from '../src/sync/http.js';
import { cleanClient, cleanExpense, cleanMeeting, decide } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

const BASE = 'https://office.example/api/sales/v1';
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until something is true (a slow CI machine must not make a test depend on a fixed sleep). Never throws: the assertion after it reports.
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(5);
}

let office;
let key;

async function phone({ persist = new MemoryPersist(), connect = true, code = 'REP001' } = {}) {
  const store = await Store.open(persist, key);
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) }); // late binding: a test can wrap office.fetch
  const engine = new SyncEngine({ store, http, appVersion: '1.3', deviceModel: 'Test phone', autoDelayMs: 15 });
  if (connect) await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine, persist };
}

const expense = (extra = {}) => ({ category: 'fuel', bill_type: 'with_bill', work_area: 'local', amount_paise: 45000, expense_date: today(), note: 'Taxi', ...extra });

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

// ---- signing in -----------------------------------------------------------------------------

test('connecting stores the token and the account, encrypted with the rest of the data', async () => {
  const { store, engine, persist } = await phone();

  assert.equal(engine.status.connected, true);
  assert.equal(engine.status.account.employee_code, 'REP001');
  assert.ok(store.syncState.token);

  const everything = [...persist.data.values()].join('|');
  assert.ok(!everything.includes(store.syncState.token), 'the token is not readable on disk');
});

test('a wrong password signs nobody in and stores nothing', async () => {
  const { store, engine } = await phone({ connect: false });

  await assert.rejects(engine.connect({ login: 'REP001', password: 'nope' }), (e) => e instanceof SyncError && e.code === 'INVALID_CREDENTIALS');
  assert.equal(store.syncState, null);
  assert.equal(engine.status.connected, false);
});

test('signing out keeps every record on the phone and drops the token', async () => {
  const { store, engine } = await phone();
  await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Lab Co' });

  await engine.signOut();

  assert.equal(engine.status.connected, false);
  assert.equal(engine.status.linked, true, 'the phone stays linked, so deletes are still remembered');
  assert.equal(store.clients.length, 1);
});

// ---- push ---------------------------------------------------------------------------------

test('what is saved on the phone reaches the office once, and is then marked as sent', async () => {
  const { store, engine } = await phone();
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Lab Co', phone: '98765 43210' });
  await store.saveExpense(expense());
  await store.saveMeeting({ client_id: client.id, client_name: 'Lab Co', meeting_at: new Date().toISOString(), purpose: 'Demo' });
  assert.equal(store.unsyncedCount, 3);

  const first = await engine.syncNow();

  assert.equal(first.pushed, 3);
  assert.equal(store.unsyncedCount, 0);
  assert.equal(office.count('expenses'), 1);
  assert.equal(office.count('clients'), 1);
  assert.equal(office.count('meetings'), 1);
  assert.equal(engine.status.lastError, null);
  assert.ok(engine.status.lastSyncAt);

  const pushes = office.calls.filter((c) => c.path === '/sync/push').length;
  await engine.syncNow();
  assert.equal(office.calls.filter((c) => c.path === '/sync/push').length, pushes, 'nothing to send: no second push');
  assert.equal(office.count('expenses'), 1);
});

test('the office never gets a status, a token or anything the phone does not own', async () => {
  const { store, engine } = await phone();
  await store.saveExpense(expense());
  await engine.syncNow();

  const sent = office.calls.find((c) => c.path === '/sync/push').body.expenses[0];
  assert.deepEqual(Object.keys(sent).sort(), ['amount_paise', 'bill_type', 'category', 'expense_date', 'has_bill', 'note', 'updated_at', 'uuid', 'work_area']);
});

test('an edit made while the push is on its way is not lost, and is sent in the next round', async () => {
  const { store, engine } = await phone();
  const saved = await store.saveExpense(expense({ note: 'first' }));

  let edit;
  office.onPush = () => {
    office.onPush = null;
    edit = store.saveExpense({ ...expense({ note: 'edited meanwhile' }), id: saved.id });
  };
  await engine.syncNow();
  await edit;
  // Depending on timing the edit lands before the sync's last round (sent in the same sync) or just after it
  // (still waiting: in the app a user change schedules the next sync by itself). Either way one more sync settles it.
  await engine.syncNow();

  // the first push carried "first"; the edit must not have been overwritten by the "sent" bookkeeping of that push
  assert.equal(store.expenses[0].note, 'edited meanwhile');
  assert.equal(office.rows.expenses.get(saved.id).data.note, 'edited meanwhile', 'the edit reached the office');
  assert.equal(store.expenses[0].synced, true);
  assert.ok(office.calls.filter((c) => c.path === '/sync/push').length >= 2);
});

test('many quick saves and a sync at the same moment never lose or double anything', async () => {
  const { store, engine } = await phone();
  const names = Array.from({ length: 12 }, (_, i) => `Client ${i}`);

  await Promise.all([...names.map((name) => store.saveClient({ lat: 26.9124, lng: 75.7873, name })), engine.syncNow(), engine.syncNow()]);
  await engine.syncNow();

  assert.equal(store.clients.length, 12);
  assert.equal(office.count('clients'), 12);
  assert.equal(store.unsyncedCount, 0);
});

test('offline: nothing is lost, the reason is shown, and the next sync sends it', async () => {
  const { store, engine } = await phone();
  await store.saveExpense(expense());
  office.offline = true;

  await engine.syncNow();
  assert.match(engine.status.lastError, /Could not reach the office/);
  assert.equal(store.unsyncedCount, 1);
  assert.equal(engine.status.connected, true, 'being offline never signs the rep out');

  office.offline = false;
  await engine.syncNow();
  assert.equal(store.unsyncedCount, 0);
  assert.equal(engine.status.lastError, null);
});

test('a server error leaves everything to be tried again', async () => {
  const { store, engine } = await phone();
  await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Lab Co' });
  office.failPushWith = 500;

  await engine.syncNow();
  assert.equal(store.unsyncedCount, 1);
  assert.ok(engine.status.lastError);

  office.failPushWith = null;
  await engine.syncNow();
  assert.equal(store.unsyncedCount, 0);
});

test('a record the office refuses is kept, explained, and not sent again until it is edited', async () => {
  const { store, engine } = await phone();
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Lab Co' });
  office.validate = (kind, r) => (kind === 'clients' ? 'The office does not like this name.' : null);

  const first = await engine.syncNow();
  assert.equal(first.refused, 1);
  assert.equal(store.refused[0].message, 'The office does not like this name.');
  assert.equal(store.unsyncedCount, 0, 'a refused record is not "waiting to be sent"');

  const calls = office.calls.length;
  await engine.syncNow();
  assert.equal(office.calls.filter((c) => c.path === '/sync/push').length, 1, 'not sent again');
  assert.ok(office.calls.length > calls);

  office.validate = () => null;
  await store.saveClient({ lat: 26.9124, lng: 75.7873, id: client.id, name: 'Lab Company' });
  assert.equal(store.refused.length, 0, 'editing clears the refusal');
  await engine.syncNow();
  assert.equal(office.count('clients'), 1);
});

// ---- the office decides ---------------------------------------------------------------------

test('approval and rejection come back to the phone, and then the expense is final', async () => {
  const { store, engine } = await phone();
  const a = await store.saveExpense(expense({ note: 'approve me' }));
  const b = await store.saveExpense(expense({ note: 'reject me' }));
  await engine.syncNow();

  office.review(a.id, 'approved');
  office.review(b.id, 'rejected', 'Bill is missing');
  await engine.syncNow();

  const byId = Object.fromEntries(store.expenses.map((e) => [e.id, e]));
  assert.equal(byId[a.id].status, 'approved');
  assert.equal(byId[b.id].status, 'rejected');
  assert.equal(byId[b.id].reject_reason, 'Bill is missing');
  assert.ok(byId[b.id].reviewed_at);

  await assert.rejects(store.saveExpense({ ...expense(), id: a.id }), /already reviewed/);
  await assert.rejects(store.deleteExpense(b.id), /already reviewed/);
  assert.equal(store.expenses.length, 2);
});

test('the office decision wins even over an edit the phone had not sent yet', async () => {
  const { store, engine } = await phone();
  const saved = await store.saveExpense(expense({ amount_paise: 1000 }));
  await engine.syncNow();

  await store.saveExpense({ ...expense({ amount_paise: 999900 }), id: saved.id }); // edited offline, not sent
  office.review(saved.id, 'approved');

  await engine.syncNow();

  const now = store.expenses[0];
  assert.equal(now.status, 'approved');
  assert.equal(now.amount_paise, 1000, 'the approved figure is the one the office holds');
  assert.equal(office.rows.expenses.get(saved.id).data.amount_paise, 1000);
});

test('changes on the phone that were not sent beat an older office copy', async () => {
  const { store, engine } = await phone();
  const c = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Old Name' });
  await engine.syncNow();

  await store.saveClient({ lat: 26.9124, lng: 75.7873, id: c.id, name: 'New Name' });
  office.offline = true;
  await engine.syncNow();
  office.offline = false;

  await engine.syncNow();
  assert.equal(store.clients[0].name, 'New Name');
  assert.equal(office.rows.clients.get(c.id).data.name, 'New Name');
});

// ---- deleting -----------------------------------------------------------------------------

test('a delete is remembered until the office has heard of it', async () => {
  const { store, engine } = await phone();
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Lab Co' });
  await engine.syncNow();

  await store.deleteClient(client.id);
  assert.equal(store.tombstones.length, 1);
  assert.equal(store.unsyncedCount, 1);

  office.offline = true;
  await engine.syncNow();
  assert.equal(store.tombstones.length, 1, 'still remembered while offline');
  office.offline = false;

  await engine.syncNow();
  assert.equal(store.tombstones.length, 0);
  assert.equal(office.count('clients'), 0);
});

test('a phone that was never linked does not collect delete memories', async () => {
  const { store } = await phone({ connect: false });
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Lab Co' });

  await store.deleteClient(client.id);
  assert.equal(store.tombstones.length, 0);
});

test('a deleted record does not come back from the office', async () => {
  const { store, engine } = await phone();
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Lab Co' });
  await engine.syncNow();

  office.offline = true;
  await store.deleteClient(client.id);       // the office has not heard yet
  office.offline = false;

  await engine.syncNow();
  assert.equal(store.clients.length, 0);
});

test('a record deleted on the office side (from another phone of the same rep) disappears here too', async () => {
  const { store, engine } = await phone();
  const gone = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Gone One' });
  await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Stays' });
  await engine.syncNow();

  office.rows.clients.get(gone.id).deleted = true;
  office.rows.clients.get(gone.id).rev = ++office.rev;

  await engine.syncNow();

  assert.deepEqual(store.clients.map((c) => c.name), ['Stays']);
  assert.equal(store.tombstones.length, 0, 'removing it because the office said so is not a delete to report back');
});

// ---- a new phone / restore -----------------------------------------------------------------------

test('a new phone gets everything back, including bill photos', async () => {
  const old = await phone();
  const client = await old.store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Lab Co', phone: '98765 43210' });
  const e = await old.store.saveExpense(expense({ note: 'with photo' }), { bill: jpeg });
  await old.store.saveMeeting({ client_id: client.id, client_name: 'Lab Co', meeting_at: new Date().toISOString(), next_followup_at: new Date(Date.now() + 86_400_000).toISOString() });
  await old.engine.syncNow();
  await old.engine.syncNow();
  assert.equal(office.bills.size, 1);
  office.review(e.id, 'approved');

  const fresh = await phone({ persist: new MemoryPersist(), code: 'REP001' });
  const summary = await fresh.engine.syncNow();

  assert.equal(fresh.store.clients.length, 1);
  assert.equal(fresh.store.clients[0].phone, '+919876543210');
  assert.equal(fresh.store.meetings.length, 1);
  assert.equal(fresh.store.meetings[0].client_id, client.id);
  assert.equal(fresh.store.expenses[0].status, 'approved');
  assert.equal(fresh.store.expenses[0].synced, true);
  assert.equal(summary.billsDown, 1);
  assert.deepEqual([...(await fresh.store.billFor(e.id))], [...jpeg]);
  assert.equal(fresh.store.unsyncedCount, 0);
});

test('another rep never sees these records', async () => {
  const a = await phone({ code: 'REP001' });
  await a.store.saveExpense(expense({ note: 'private to A' }));
  await a.engine.syncNow();

  const b = await phone({ code: 'REP002', persist: new MemoryPersist() });
  await b.engine.syncNow();

  assert.equal(b.store.expenses.length, 0);
});

test('a big backlog comes back in pages', async () => {
  const a = await phone();
  for (let i = 0; i < 7; i++) await a.store.saveClient({ lat: 26.9124, lng: 75.7873, name: `Client ${i}` });
  await a.engine.syncNow();
  office.limit = 3;

  const fresh = await phone({ persist: new MemoryPersist() });
  await fresh.engine.syncNow();

  assert.equal(fresh.store.clients.length, 7);
});

// ---- bill photos -----------------------------------------------------------------------------------

test('a bill photo is uploaded once after its expense, and a retake is uploaded again', async () => {
  const { store, engine } = await phone();
  const saved = await store.saveExpense(expense(), { bill: jpeg });
  assert.equal(store.expenses[0].bill_synced, false);

  const first = await engine.syncNow();
  assert.equal(first.billsUp, 1);
  assert.equal(store.expenses[0].bill_synced, true);
  assert.equal(office.bills.size, 1);

  const again = await engine.syncNow();
  assert.equal(again.billsUp, 0);

  await store.saveExpense({ ...expense(), id: saved.id }, { bill: Uint8Array.from([0xff, 0xd8, 0xff, 9, 9, 9]) });
  assert.equal(store.expenses[0].bill_synced, false);
  assert.equal((await engine.syncNow()).billsUp, 1);
});

test('removing a photo needs no upload', async () => {
  const { store, engine } = await phone();
  const saved = await store.saveExpense(expense(), { bill: jpeg });
  await engine.syncNow();

  await store.saveExpense({ ...expense(), id: saved.id }, { removeBill: true });
  assert.equal(store.expenses[0].has_bill, false);
  assert.equal((await engine.syncNow()).billsUp, 0);
});

test('a photo the office will never take does not make the sync loop', async () => {
  const { store, engine } = await phone();
  const saved = await store.saveExpense(expense(), { bill: jpeg });
  await engine.syncNow();
  office.review(saved.id, 'approved');
  await engine.syncNow();

  // a reviewed expense: even if a photo were still waiting, the office answers LOCKED and the phone stops trying
  const record = store.getRecord('expense', saved.id);
  await store.putFromServer('expense', { ...record, bill_synced: false });
  await engine.syncNow();
  assert.equal(store.expenses[0].bill_synced, true);
});

// ---- being signed out ------------------------------------------------------------------------------

test('a switched-off rep is told so, and the phone keeps its data', async () => {
  const { store, engine } = await phone();
  await store.saveExpense(expense());

  // the office signs the phone out first (401); the next sign-in attempt then says why
  office.switchOff('REP001');
  await engine.syncNow();
  assert.equal(engine.status.connected, false);
  assert.equal(engine.status.needsSignIn, true);
  assert.equal(store.expenses.length, 1);

  await assert.rejects(engine.connect({ login: 'REP001', password: 'secret-pass-1' }), (e) => e.code === 'ACCOUNT_INACTIVE');
  assert.equal(store.expenses.length, 1);
});

test('a 403 on a live token (switched off between two calls) also signs the phone out, with the reason', async () => {
  const { store, engine } = await phone();
  await store.saveExpense(expense());

  office.users.get('REP001').active = false; // tokens still alive: the office answers 403
  await engine.syncNow();

  assert.equal(engine.status.connected, false);
  assert.match(engine.status.lastError, /switched off/);
  assert.equal(store.expenses.length, 1);
});

test('an expired token asks for a new sign-in, and signing in again carries on', async () => {
  const { store, engine } = await phone();
  await store.saveExpense(expense());

  office.tokens.clear();
  await engine.syncNow();
  assert.equal(engine.status.needsSignIn, true);
  assert.match(engine.status.lastError, /sign in/i);
  assert.equal(store.unsyncedCount, 1);

  await engine.connect({ login: 'REP001', password: 'secret-pass-1' });
  await engine.syncNow();
  assert.equal(store.unsyncedCount, 0);
  assert.equal(engine.status.needsSignIn, false);
});

test('a different account starts from the beginning (no cursor of the other account)', async () => {
  const { store, engine } = await phone({ code: 'REP001' });
  await engine.syncNow();
  assert.ok(store.syncState.cursor);

  await engine.connect({ login: 'REP002', password: 'secret-pass-1' });
  assert.equal(store.syncState.cursor, null);
});

// ---- running --------------------------------------------------------------------------------------

test('only one sync runs at a time; a change during it triggers one more right after', async () => {
  const { store, engine } = await phone();
  await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'One' });

  let inside = 0;
  let maxInside = 0;
  const original = office.fetch;
  office.fetch = async (...args) => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await sleep(5);
    try { return await original(...args); } finally { inside--; }
  };

  await Promise.all([engine.syncNow(), engine.syncNow(), engine.syncNow()]);
  assert.equal(maxInside, 1);
});

test('saving something starts a sync by itself a moment later, and stop() ends that', async () => {
  const { store, engine } = await phone();
  engine.start();

  await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Auto' });
  await until(() => office.count('clients') === 1 && store.unsyncedCount === 0);
  assert.equal(office.count('clients'), 1);
  assert.equal(store.unsyncedCount, 0);

  engine.stop();
  await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'After stop' });
  await sleep(150); // a negative: it must stay unsent, so there is nothing to wait for
  assert.equal(office.count('clients'), 1);
});

test('the engine does nothing without a token', async () => {
  const { store, engine } = await phone({ connect: false });
  await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'Local only' });

  await engine.syncNow();
  assert.equal(office.calls.length, 0);
});

// ---- what comes from the office is checked ----------------------------------------------------------

test('hostile or broken records from the office are dropped or trimmed, never trusted', async () => {
  const { store, engine } = await phone();
  const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;

  office.rows.expenses.set(id(1), { owner: 1, rev: ++office.rev, deleted: false, data: { uuid: id(1), category: 'gold', amount_paise: 5, expense_date: today(), status: 'pending', updated_at: new Date().toISOString() } });
  office.rows.expenses.set(id(2), { owner: 1, rev: ++office.rev, deleted: false, data: { uuid: id(2), category: 'fuel', amount_paise: -9, expense_date: today(), status: 'pending', updated_at: new Date().toISOString() } });
  office.rows.expenses.set(id(3), { owner: 1, rev: ++office.rev, deleted: false, data: { uuid: id(3), category: 'fuel', amount_paise: 100, expense_date: today(), status: 'approved-by-hacker', updated_at: new Date().toISOString() } });
  office.rows.expenses.set(id(4), { owner: 1, rev: ++office.rev, deleted: false, data: { uuid: id(4), category: 'fuel', amount_paise: 100, expense_date: today(), status: 'pending', note: `<img src=x onerror=alert(1)>${'x'.repeat(5000)}`, updated_at: new Date().toISOString() } });
  office.rows.clients.set(id(5), { owner: 1, rev: ++office.rev, deleted: false, data: { uuid: id(5), name: 'A', updated_at: new Date().toISOString() } });
  office.rows.expenses.set('not-a-uuid', { owner: 1, rev: ++office.rev, deleted: false, data: { uuid: 'not-a-uuid', category: 'fuel', amount_paise: 100, expense_date: today(), status: 'pending', updated_at: new Date().toISOString() } });

  await engine.syncNow();

  assert.deepEqual(store.expenses.map((e) => e.id), [id(4)]);
  assert.ok(store.expenses[0].note.length <= 1000, 'a huge note is cut');
  assert.equal(store.clients.length, 0);
});

test('cleaning: every kind keeps only well-formed data', () => {
  const t = new Date().toISOString();
  assert.equal(cleanExpense({ uuid: 'x' }), null);
  assert.equal(cleanClient({ uuid: '00000000-0000-4000-8000-000000000001', name: 'A', updated_at: t }), null);
  assert.equal(cleanMeeting({ uuid: '00000000-0000-4000-8000-000000000001', client_name: '', meeting_at: t, updated_at: t }), null);
  assert.equal(cleanMeeting({ uuid: '00000000-0000-4000-8000-000000000001', client_name: 'X', meeting_at: 'yesterday', updated_at: t }), null);

  const m = cleanMeeting({ uuid: '00000000-0000-4000-8000-000000000001', client_uuid: 'junk', client_name: 'X', meeting_at: t, next_followup_at: null, updated_at: t });
  assert.equal(m.client_id, null);
});

test('merge decisions', () => {
  const server = (extra = {}) => ({ status: 'pending', updated_at: '2026-10-25T10:00:00.000Z', ...extra });
  const local = (extra = {}) => ({ synced: true, updated_at: '2026-10-25T09:00:00.000Z', ...extra });

  assert.equal(decide('client', null, server()), 'create');
  assert.equal(decide('client', local(), server()), 'replace');
  assert.equal(decide('client', local({ updated_at: '2026-10-25T11:00:00.000Z' }), server()), 'keep');
  assert.equal(decide('client', local({ synced: false }), server()), 'keep');
  assert.equal(decide('expense', local({ synced: false }), server({ status: 'approved' })), 'replace');
  assert.equal(decide('expense', local({ synced: false }), server({ status: 'pending' })), 'keep');
});

// ---- the network layer --------------------------------------------------------------------------------

test('only https is allowed (plain http only for this computer, and only when the build allows it)', () => {
  assert.throws(() => assertSecureBase('http://office.example'), (e) => e.code === 'INSECURE_URL');
  assert.throws(() => assertSecureBase('http://127.0.0.1:8000'), (e) => e.code === 'INSECURE_URL');
  assert.throws(() => assertSecureBase('http://office.example', true), (e) => e.code === 'INSECURE_URL');
  assert.throws(() => assertSecureBase('ftp://office.example'), (e) => e.code === 'INSECURE_URL');
  assert.throws(() => assertSecureBase('not a url'), (e) => e.code === 'BAD_URL');
  assert.doesNotThrow(() => assertSecureBase('https://office.example'));
  assert.doesNotThrow(() => assertSecureBase('http://127.0.0.1:8000', true));
});

test('every call is strict: no cookies, no redirects, no cache, a token only to the office', async () => {
  const seen = [];
  const http = createHttp({ base: BASE, appVersion: '1.3', fetchFn: async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); } });

  await http.get('/me', { token: 'abc', query: { since: '2026-01-01' } });

  const { url, init } = seen[0];
  assert.equal(url, 'https://office.example/api/sales/v1/me?since=2026-01-01');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers.Authorization, 'Bearer abc');
  assert.equal(init.headers['X-App-Version'], '1.3');
});

test('a slow server is given up on, and errors keep their code', async () => {
  const slow = createHttp({ base: BASE, timeoutMs: 20, fetchFn: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
  await assert.rejects(slow.get('/me'), (e) => e.code === 'OFFLINE');

  const failing = createHttp({ base: BASE, fetchFn: async () => new Response('{"code":"LOCKED","message":"Reviewed","errors":{}}', { status: 409 }) });
  await assert.rejects(failing.post('/x', {}), (e) => e.code === 'LOCKED' && e.status === 409 && e.message === 'Reviewed');

  const html = createHttp({ base: BASE, fetchFn: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }) });
  await assert.rejects(html.get('/x'), (e) => e.code === 'HTTP_502');

  const weird = createHttp({ base: BASE, fetchFn: async () => new Response('"just a string"', { status: 200 }) });
  await assert.rejects(weird.get('/x'), (e) => e.code === 'BAD_RESPONSE');
});
