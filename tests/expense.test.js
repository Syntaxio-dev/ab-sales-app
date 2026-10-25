import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import * as rules from '../src/core/rules.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { cleanExpense } from '../src/sync/merge.js';
import { expensesCsv } from '../src/ui/export.js';
import { formatPicked, parseValue } from '../src/ui/pickers.js';

// An expense must say where the work was (local / outstation) and whether there is a bill. No default: the rep chooses every time.

let store;
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const today = () => new Date().toISOString().slice(0, 10);
const expense = (extra = {}) => ({ category: 'parking', amount_paise: 6000, expense_date: today(), note: '', work_area: 'local', bill_type: 'with_bill', ...extra });

beforeEach(async () => {
  store = await Store.open(new MemoryPersist(), await aesKey(randomBytes(32)));
  await store.saveProfile({ name: 'Test Rep', employeeCode: 'REP001' });
});

test('the categories are Travel, Food, Petrol, Parking, Gifting, Lodging and Miscellaneous', () => {
  assert.deepEqual(rules.CATEGORIES, ['travel', 'food', 'fuel', 'parking', 'gifting', 'lodging', 'other']);
  assert.deepEqual(rules.CATEGORIES.map(rules.categoryLabel), ['Travel', 'Food', 'Petrol', 'Parking charges', 'Gifting', 'Lodging', 'Miscellaneous']);
  assert.equal(rules.categoryLabel('something-old'), 'something-old', 'an unknown key is shown as it is');
});

test('the work area and the bill answer are required, with no way around it', async () => {
  for (const missing of [{ work_area: undefined }, { work_area: '' }, { work_area: 'abroad' }, { bill_type: undefined }, { bill_type: null }, { bill_type: 'maybe' }]) {
    await assert.rejects(store.saveExpense(expense(missing)), ValidationError, JSON.stringify(missing));
  }
  assert.equal(store.expenses.length, 0, 'nothing was saved');

  for (const category of rules.CATEGORIES) {
    const saved = await store.saveExpense(expense({ category }));
    assert.equal(saved.category, category);
  }
  assert.equal(store.expenses.length, rules.CATEGORIES.length);
});

test('"without bill" never keeps a photo', async () => {
  const saved = await store.saveExpense(expense(), { bill: jpeg });
  assert.equal(saved.has_bill, true);

  const edited = await store.saveExpense({ ...expense({ bill_type: 'without_bill' }), id: saved.id });
  assert.equal(edited.has_bill, false, 'the photo is dropped when the rep says there is no bill');
  assert.equal(await store.billFor(saved.id), null);

  const another = await store.saveExpense(expense({ bill_type: 'without_bill' }), { bill: jpeg });
  assert.equal(another.has_bill, false, 'a photo sent with "without bill" is ignored');
  assert.equal(another.bill_type, 'without_bill');
});

test('an old expense without the two answers loads with nulls and shows as before', () => {
  const old = cleanExpense({ uuid: '00000000-0000-4000-8000-000000000001', category: 'lodging', amount_paise: 100, expense_date: '2026-10-01', status: 'pending', updated_at: '2026-10-01T10:00:00.000Z' });
  assert.equal(old.work_area, null);
  assert.equal(old.bill_type, null);
  assert.equal(old.category, 'lodging');

  const fresh = cleanExpense({ ...{ uuid: '00000000-0000-4000-8000-000000000002', category: 'gifting', amount_paise: 100, expense_date: '2026-10-01', status: 'pending', updated_at: '2026-10-01T10:00:00.000Z' }, work_area: 'outstation', bill_type: 'without_bill' });
  assert.equal(fresh.work_area, 'outstation');
  assert.equal(fresh.bill_type, 'without_bill');

  const odd = cleanExpense({ uuid: '00000000-0000-4000-8000-000000000003', category: 'food', amount_paise: 100, expense_date: '2026-10-01', status: 'pending', updated_at: '2026-10-01T10:00:00.000Z', work_area: '<b>', bill_type: 7 });
  assert.equal(odd.work_area, null, 'an answer the office sends that is not one of ours is dropped');
  assert.equal(odd.bill_type, null);
});

test('the CSV export has the new columns and the readable labels', async () => {
  await store.saveExpense(expense({ category: 'fuel', work_area: 'outstation', bill_type: 'without_bill' }));
  const csv = expensesCsv(store);
  assert.match(csv, /Work area,Bill/);
  assert.match(csv, /Petrol/);
  assert.match(csv, /Outstation \(outside Jaipur\)/);
  assert.match(csv, /Without bill/);
});

test('picker values are read and shown', () => {
  assert.deepEqual(parseValue('2026-10-26T16:30'), { y: 2026, mo: 9, d: 26, hh: 16, mm: 30 });
  assert.deepEqual(parseValue('2026-01-05'), { y: 2026, mo: 0, d: 5, hh: 0, mm: 0 });
  for (const bad of ['', null, undefined, '26-10-2026', '2026-10-26 16:30', 'abc']) assert.equal(parseValue(bad), null, String(bad));

  assert.match(formatPicked('date', '2026-10-26'), /26 Oct 2026/);
  assert.match(formatPicked('datetime', '2026-10-26T16:30'), /26 Oct 2026.*4:30\s?pm/i);
  assert.equal(formatPicked('date', ''), '');
});
