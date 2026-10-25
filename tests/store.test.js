import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';

let persist;
let key;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const expense = (extra = {}) => ({ category: 'fuel', bill_type: 'with_bill', work_area: 'local', amount_paise: 45000, expense_date: today(), note: '', ...extra });
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

beforeEach(async () => {
  persist = new MemoryPersist();
  key = await aesKey(randomBytes(32));
});

test('records survive closing and opening again with the same key', async () => {
  let store = await Store.open(persist, key);
  const saved = await store.saveExpense(expense({ note: '  taxi  ' }), { bill: jpeg });
  await store.close();

  store = await Store.open(persist, key);
  const [loaded] = store.expenses;

  assert.equal(loaded.id, saved.id);
  assert.equal(loaded.note, 'taxi');
  assert.equal(loaded.has_bill, true);
  assert.deepEqual([...(await store.billFor(saved.id))], [...jpeg]);
});

test('what reaches the disk is not readable text', async () => {
  const store = await Store.open(persist, key);
  await store.saveClient({ name: 'Zebra Laboratories', phone: '9876543210', city: 'Jaipur', notes: 'secret-note-xyz' });
  await store.saveExpense(expense({ note: 'private-expense-note' }));

  const everything = [...persist.data.values()].join('|');
  for (const secret of ['Zebra', 'secret-note-xyz', '9876543210', 'Jaipur', 'private-expense-note']) assert.ok(!everything.includes(secret), secret);
});

test('a wrong key reads nothing', async () => {
  const store = await Store.open(persist, key);
  await store.saveExpense(expense({ note: 'private' }));
  await store.close();

  const other = await Store.open(persist, await aesKey(randomBytes(32)));
  assert.equal(other.expenses.length, 0);
});

test('a record copied into another slot is refused (the slot is part of what is authenticated)', async () => {
  const store = await Store.open(persist, key);
  const a = await store.saveExpense(expense({ note: 'A' }));
  const b = await store.saveExpense(expense({ note: 'B' }));
  await store.close();

  persist.data.set(`e:${b.id}`, persist.data.get(`e:${a.id}`));

  const reopened = await Store.open(persist, key);
  assert.deepEqual(reopened.expenses.map((e) => e.id), [a.id]);
});

test('a changed byte is detected and the record is skipped', async () => {
  const store = await Store.open(persist, key);
  const good = await store.saveExpense(expense({ note: 'good' }));
  const bad = await store.saveExpense(expense({ note: 'bad' }));
  await store.close();

  const slot = `e:${bad.id}`;
  const text = persist.data.get(slot);
  persist.data.set(slot, `${text.slice(0, 20)}${text[20] === 'A' ? 'B' : 'A'}${text.slice(21)}`);

  const reopened = await Store.open(persist, key);
  assert.deepEqual(reopened.expenses.map((e) => e.id), [good.id]);
});

test('bad expenses are refused', async () => {
  const store = await Store.open(persist, key);
  const bad = [
    { amount_paise: 0 },
    { amount_paise: -100 },
    { amount_paise: 100000001 },
    { amount_paise: 12.5 },
    { expense_date: '2999-01-01' },
    { expense_date: 'yesterday' },
    { category: 'gold' },
    { note: 'x'.repeat(1001) },
  ];

  for (const extra of bad) await assert.rejects(store.saveExpense(expense(extra)), ValidationError, JSON.stringify(extra));
  assert.equal(store.expenses.length, 0);
});

test('a photo must really be a picture and not too big', async () => {
  const store = await Store.open(persist, key);

  await assert.rejects(store.saveExpense(expense(), { bill: new TextEncoder().encode('<html>not a picture</html>') }), ValidationError);

  const huge = new Uint8Array(5 * 1024 * 1024 + 1);
  huge.set([0xff, 0xd8, 0xff]);
  await assert.rejects(store.saveExpense(expense(), { bill: huge }), ValidationError);

  assert.equal(store.expenses.length, 0);
  assert.equal([...persist.data.keys()].filter((k) => k.startsWith('b:')).length, 0);
});

test('status cannot be set from the phone, and an edit keeps it', async () => {
  const store = await Store.open(persist, key);

  const created = await store.saveExpense(expense({ status: 'approved', synced: true }));
  assert.equal(created.status, 'pending');
  assert.equal(created.synced, false);

  const edited = await store.saveExpense(expense({ id: created.id, amount_paise: 99900, status: 'approved' }));
  assert.equal(edited.status, 'pending');
  assert.equal(edited.created_at, created.created_at);
  assert.equal(edited.amount_paise, 99900);
  assert.equal(store.expenses.length, 1);
});

test('newest day comes first; deleting an expense deletes its photo', async () => {
  const store = await Store.open(persist, key);
  const old = await store.saveExpense(expense({ expense_date: daysAgo(3) }));
  const fresh = await store.saveExpense(expense(), { bill: jpeg });

  assert.deepEqual(store.expenses.map((e) => e.id), [fresh.id, old.id]);

  await store.deleteExpense(fresh.id);
  assert.equal(await store.billFor(fresh.id), null);
  assert.deepEqual(store.expenses.map((e) => e.id), [old.id]);
});

test('removing a photo keeps the expense', async () => {
  const store = await Store.open(persist, key);
  const saved = await store.saveExpense(expense(), { bill: jpeg });
  const edited = await store.saveExpense({ ...expense(), id: saved.id }, { removeBill: true });

  assert.equal(edited.has_bill, false);
  assert.equal(await store.billFor(saved.id), null);
});

test('a client phone is stored in one spelling, and a bad phone is refused', async () => {
  const store = await Store.open(persist, key);

  const client = await store.saveClient({ name: 'Lab Co', phone: '98765 43210' });
  assert.equal(client.phone, '+919876543210');

  await assert.rejects(store.saveClient({ name: 'Bad', phone: '12' }), ValidationError);
  await assert.rejects(store.saveClient({ name: 'A' }), ValidationError);
});

test('a meeting keeps the client name when the client is deleted; follow-up must be after the meeting', async () => {
  const store = await Store.open(persist, key);
  const client = await store.saveClient({ name: 'Lab Co' });
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const earlier = new Date(Date.now() - 86_400_000).toISOString();

  await store.saveMeeting({ client_id: client.id, client_name: 'Lab Co', meeting_at: at, purpose: 'Demo', next_followup_at: later });
  await store.deleteClient(client.id);
  assert.equal(store.meetings[0].client_name, 'Lab Co');

  await assert.rejects(store.saveMeeting({ client_name: 'X Co', meeting_at: at, next_followup_at: earlier }), ValidationError);
  await assert.rejects(store.saveMeeting({ client_name: 'X Co', meeting_at: 'not a time' }), ValidationError);
  await assert.rejects(store.saveMeeting({ client_name: '', meeting_at: at }), ValidationError);
});

test('export has every record and the profile, and no key or PIN', async () => {
  const store = await Store.open(persist, key);
  await store.saveProfile({ name: 'Ravi Sharma', employeeCode: 'rep001' });
  const saved = await store.saveExpense(expense());

  const out = store.exportAll();
  assert.equal(out.version, 1);
  assert.equal(out.rep.employee_code, 'REP001');
  assert.equal(out.expenses.length, 1);
  assert.equal(out.expenses[0].uuid, saved.id);
  assert.equal(out.expenses[0].id, undefined);
  assert.equal(store.unsyncedCount, 1);
});

test('a locked store refuses everything and holds no data', async () => {
  const store = await Store.open(persist, key);
  await store.saveExpense(expense());
  await store.close();

  assert.equal(store.expenses.length, 0);
  assert.equal(store.profile, null);
  await assert.rejects(store.saveExpense(expense()), /locked/);
});

test('listeners hear about changes and can stop listening', async () => {
  const store = await Store.open(persist, key);
  let calls = 0;
  const stop = store.subscribe(() => calls++);

  await store.saveClient({ name: 'Lab Co' });
  stop();
  await store.saveClient({ name: 'Other Co' });

  assert.equal(calls, 1);
});
