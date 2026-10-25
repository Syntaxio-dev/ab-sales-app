import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { MemoryPersist } from '../src/data/persist.js';
import { Store } from '../src/data/store.js';
import { aesKey, seal, toBase64, utf8 } from '../src/security/crypto.js';

// UPDATES KEEP THE DATA. This test opens records exactly as app v1.0 wrote them and checks that the current code reads
// them. If it fails after a change, the change would break the data on every phone that already has the app: fix the
// code (add a default, keep the old field), never the fixture.

const fixture = JSON.parse(readFileSync(new URL('./fixtures/v1.0-data.json', import.meta.url), 'utf8'));
const testKey = () => aesKey(Uint8Array.from(fixture.key_bytes));

async function openOld() {
  const persist = new MemoryPersist();
  for (const [slot, text] of Object.entries(fixture.slots)) await persist.set(slot, text);
  return { persist, store: await Store.open(persist, await testKey()) };
}

test('v1.0 records are still readable, with every field', async () => {
  const { store } = await openOld();

  assert.deepEqual(store.profile, { name: 'Ravi Sharma', employee_code: 'REP001' });

  const [client] = store.clients;
  assert.equal(client.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(client.name, 'Lab Co');
  assert.equal(client.company, 'Lab Co Pvt Ltd');
  assert.equal(client.phone, '+919876543210');
  assert.equal(client.city, 'Jaipur');

  const [expense] = store.expenses;
  assert.equal(expense.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(expense.category, 'fuel');
  assert.equal(expense.amount_paise, 123450);
  assert.equal(expense.expense_date, '2026-10-20');
  assert.equal(expense.note, 'Taxi to the lab');
  assert.equal(expense.has_bill, true);
  assert.equal(expense.status, 'pending');
  assert.equal(expense.synced, false);

  const [meeting] = store.meetings;
  assert.equal(meeting.id, '33333333-3333-4333-8333-333333333333');
  assert.equal(meeting.client_id, client.id);
  assert.equal(meeting.client_name, 'Lab Co');
  assert.equal(meeting.meeting_at, '2026-10-20T05:30:00.000Z');
  assert.equal(meeting.next_followup_at, '2026-10-27T05:30:00.000Z');
});

test('the bill photo of a v1.0 expense is still readable', async () => {
  const { store } = await openOld();
  assert.deepEqual([...(await store.billFor('22222222-2222-4222-8222-222222222222'))], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
});

test('old records can be edited and saved again by the new code, and stay readable', async () => {
  const { persist, store } = await openOld();
  const [expense] = store.expenses;

  await store.saveExpense({ id: expense.id, category: expense.category, bill_type: 'with_bill', work_area: 'local', amount_paise: 99900, expense_date: expense.expense_date, note: 'edited' });
  await store.close();

  const again = await Store.open(persist, await testKey());
  assert.equal(again.expenses[0].amount_paise, 99900);
  assert.equal(again.expenses[0].has_bill, true); // the old photo is kept when an old expense is edited
  assert.equal(again.expenses[0].created_at, expense.created_at);
});

test('a record written by an OLDER app, with fewer fields, still loads with defaults for the new ones', async () => {
  const key = await testKey();
  const persist = new MemoryPersist();

  // what an early version could have stored: only the fields that existed then
  const bare = { id: '44444444-4444-4444-8444-444444444444', category: 'food', amount_paise: 5000, expense_date: '2026-10-21', created_at: '2026-10-21T04:00:00.000Z', updated_at: '2026-10-21T04:00:00.000Z' };
  const slot = `e:${bare.id}`;
  await persist.set(slot, toBase64(await seal(key, utf8(JSON.stringify(bare)), slot)));

  const store = await Store.open(persist, key);
  const [loaded] = store.expenses;

  assert.equal(loaded.note, '');
  assert.equal(loaded.has_bill, false);
  assert.equal(loaded.status, 'pending');
  assert.equal(loaded.synced, false);
});

test('a record written by a NEWER app, with extra fields, is not damaged by this version', async () => {
  const key = await testKey();
  const persist = new MemoryPersist();

  const future = { id: '55555555-5555-4555-8555-555555555555', name: 'Zed Labs', company: '', phone: '', city: '', notes: '', synced: false, created_at: '2026-10-22T04:00:00.000Z', updated_at: '2026-10-22T04:00:00.000Z', loyalty_tier: 'gold' };
  const slot = `c:${future.id}`;
  await persist.set(slot, toBase64(await seal(key, utf8(JSON.stringify(future)), slot)));

  const store = await Store.open(persist, key);
  assert.equal(store.clients[0].name, 'Zed Labs');
  assert.equal(store.clients[0].loyalty_tier, 'gold');
});

test('the stored slot names are part of the format and must not change', async () => {
  const { persist } = await openOld();
  const slots = (await persist.keys('')).sort();

  assert.deepEqual(slots, [
    'b:22222222-2222-4222-8222-222222222222',
    'c:11111111-1111-4111-8111-111111111111',
    'e:22222222-2222-4222-8222-222222222222',
    'm:33333333-3333-4333-8333-333333333333',
    'profile',
  ]);
});
