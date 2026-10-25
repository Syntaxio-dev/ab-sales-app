import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { byUrgency, itemsSummary, needsAction, urgency } from '../src/core/enquiry.js';
import { reportId } from '../src/core/ids.js';
import { enquiriesWorked, figuresFor } from '../src/core/report.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanEnquiry, cleanReport } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

const BASE = 'https://office.example/api/sales/v1';
let office;
let key;

const day = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

async function phone({ code = 'REP001', persist = new MemoryPersist() } = {}) {
  const store = await Store.open(persist, key);
  if (!store.profile) await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '2.0', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine };
}

const input = (extra = {}) => ({
  client_name: 'JK Cement',
  contact_name: 'Rohit Sharma',
  status: 'new',
  items: [
    { product: 'Muffle Furnace', brands: 'Labtech, Remi', quantity: 1, budget_paise: 15_000_000 },
    { product: 'Hot Air Oven', brands: '', quantity: 2 },
  ],
  next_followup_at: iso(86_400_000),
  ...extra,
});

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

// ---- one enquiry, several products ---------------------------------------------------------------

test('one enquiry holds several products with brands, quantity and budget', async () => {
  const { store } = await phone();
  const e = await store.saveEnquiry(input());

  assert.equal(e.items.length, 2);
  assert.equal(e.items[1].quantity, 2);
  assert.equal(e.items[1].budget_paise, null);
  assert.equal(itemsSummary(e.items), 'Muffle Furnace, Hot Air Oven x2');
  assert.equal(e.timeline.length, 1);
  assert.equal(e.timeline[0].text, 'Enquiry opened');
});

test('what is typed is checked again before it is saved', async () => {
  const { store } = await phone();
  const bad = [
    input({ client_name: '' }),
    input({ status: 'maybe' }),
    input({ items: [] }),
    input({ items: [{ product: 'x', quantity: 1 }] }),
    input({ items: [{ product: 'Oven', quantity: 0 }] }),
    input({ items: [{ product: 'Oven', quantity: 1.5 }] }),
    input({ items: [{ product: 'Oven', quantity: 1, budget_paise: -5 }] }),
    input({ items: Array.from({ length: 11 }, () => ({ product: 'Oven', quantity: 1 })) }),
    input({ next_followup_at: 'not a date' }),
    input({ note: 'x'.repeat(501) }),
  ];

  for (const one of bad) await assert.rejects(store.saveEnquiry(one), ValidationError);
  assert.equal(store.enquiries.length, 0);
});

test('a status change and a note go into the timeline; closing clears the follow-up', async () => {
  const { store } = await phone();
  const e = await store.saveEnquiry(input());

  const sent = await store.saveEnquiry({ ...e, ...input(), id: e.id, status: 'price_sent', note: 'Mailed the quote' });
  assert.equal(sent.timeline.length, 2);
  assert.deepEqual([sent.timeline[1].status, sent.timeline[1].text], ['price_sent', 'Mailed the quote']);
  assert.ok(sent.next_followup_at);

  const noted = await store.saveEnquiry({ ...input(), id: e.id, status: 'price_sent', note: 'He will decide on Friday' });
  assert.equal(noted.timeline.length, 3);
  assert.equal(noted.timeline[2].status, null, 'a note alone is not a status change');

  const same = await store.saveEnquiry({ ...input(), id: e.id, status: 'price_sent' });
  assert.equal(same.timeline.length, 3, 'saving with nothing new adds nothing');

  const won = await store.saveEnquiry({ ...input(), id: e.id, status: 'won' });
  assert.equal(won.next_followup_at, null);
  assert.ok(won.closed_at);

  const reopened = await store.saveEnquiry({ ...input(), id: e.id, status: 'negotiation' });
  assert.equal(reopened.closed_at, null);
});

test('a follow-up further ahead than the office accepts is refused on the phone, not stuck later', async () => {
  const { store } = await phone();
  const far = iso(3 * 365 * 86_400_000);

  await assert.rejects(store.saveEnquiry(input({ next_followup_at: far })), /2 years/);
  await assert.rejects(store.saveMeeting({ client_name: 'JK', meeting_at: iso(0), next_followup_at: far }), /2 years/);
  assert.ok(await store.saveEnquiry(input({ next_followup_at: iso(300 * 86_400_000) })));
});

// ---- who needs a reminder --------------------------------------------------------------------------

test('overdue, due today and untouched enquiries need action; the most urgent come first', async () => {
  const { store } = await phone();
  const now = new Date();
  const at = (extra) => ({ opened_at: iso(-10 * 86_400_000), updated_at: iso(-1000), ...extra });

  const overdue = at({ status: 'callback', next_followup_at: iso(-3_600_000) });
  const later = at({ status: 'price_sent', next_followup_at: iso(5 * 86_400_000) });
  const idle = at({ status: 'new', next_followup_at: null, updated_at: iso(-4 * 86_400_000) });
  const fresh = at({ status: 'new', next_followup_at: null, updated_at: iso(-3_600_000) });
  const closed = at({ status: 'won', next_followup_at: null, updated_at: iso(-9 * 86_400_000) });

  assert.equal(urgency(overdue, now), 'overdue');
  assert.equal(urgency(later, now), 'planned');
  const laterToday = at({ status: 'callback', next_followup_at: new Date(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).getTime() - 1).toISOString() });
  assert.equal(urgency(laterToday, now), now.getHours() === 23 && now.getMinutes() > 58 ? 'overdue' : 'today');
  assert.equal(urgency(idle, now), 'idle');
  assert.equal(urgency(fresh, now), 'none');
  assert.equal(urgency(closed, now), 'none');
  assert.equal(needsAction(later, now), false);
  assert.deepEqual([overdue, later, idle, fresh].sort((a, b) => byUrgency(a, b, now)).map((e) => urgency(e, now)), ['overdue', 'idle', 'planned', 'none']);

  // through the store
  await store.saveEnquiry(input({ next_followup_at: iso(-60_000) }));
  await store.saveEnquiry(input({ client_name: 'Shree Cement', next_followup_at: iso(10 * 86_400_000) }));
  assert.deepEqual(store.actionableEnquiries().map((e) => e.client_name), ['JK Cement']);
});

// ---- sync ------------------------------------------------------------------------------------------

test('an enquiry reaches the office, changes with every update, and comes back on a new phone', async () => {
  const a = await phone();
  const e = await a.store.saveEnquiry(input());
  await a.engine.syncNow();
  assert.equal(office.count('enquiries'), 1);
  assert.equal(a.store.unsyncedCount, 0);

  await new Promise((r) => setTimeout(r, 5));
  await a.store.saveEnquiry({ ...input(), id: e.id, status: 'price_sent', note: 'Mailed' });
  await a.engine.syncNow();
  assert.equal(office.rows.enquiries.get(e.id).data.status, 'price_sent');

  const again = await phone({ code: 'REP001' });
  await again.engine.syncNow();
  const back = again.store.enquiryById(e.id);
  assert.equal(back.status, 'price_sent');
  assert.equal(back.items.length, 2);
  assert.equal(back.timeline.length, 2);

  // the new phone is now the rep's phone (one phone at a time): a delete made there reaches the office
  await again.store.deleteEnquiry(e.id);
  await again.engine.syncNow();
  assert.equal(office.count('enquiries'), 0);
});

test('another rep never sees my enquiries', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  await a.store.saveEnquiry(input());
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(b.store.enquiries.length, 0);
});

test('what the office sends for an enquiry is checked like everything else', () => {
  const good = { uuid: crypto.randomUUID(), client_name: 'JK', status: 'new', items: [{ product: 'Oven', quantity: 1 }], opened_at: iso(0), updated_at: iso(0), timeline: [] };

  assert.ok(cleanEnquiry(good));
  assert.equal(cleanEnquiry({ ...good, status: 'weird' }), null);
  assert.equal(cleanEnquiry({ ...good, items: [] }), null);
  assert.equal(cleanEnquiry({ ...good, items: [{ product: 'x', quantity: 1 }] }), null);
  assert.equal(cleanEnquiry({ ...good, uuid: 'nope' }), null);
  assert.equal(cleanEnquiry({ ...good, items: [{ product: 'Oven', quantity: -4, budget_paise: 'lots' }] }).items[0].quantity, 1);
});

// ---- the daily report ----------------------------------------------------------------------------------

test('the same rep and day always give the same report id', async () => {
  assert.equal(await reportId('REP001', '2026-10-27'), await reportId('REP001', '2026-10-27'));
  assert.notEqual(await reportId('REP001', '2026-10-27'), await reportId('REP002', '2026-10-27'));
  assert.notEqual(await reportId('REP001', '2026-10-27'), await reportId('REP001', '2026-10-28'));
});

test('the figures of a day are counted from what is on the phone', async () => {
  const { store } = await phone();
  const client = await store.saveClient({ name: 'JK Cement', phone: '98765 43210' });
  await store.saveCalls([
    { id: crypto.randomUUID(), direction: 'outgoing', number: '+919876543210', client_id: client.id, client_name: 'JK Cement', started_at: iso(-120_000), duration_seconds: 120 },
    { id: crypto.randomUUID(), direction: 'missed', number: '+919876543210', client_id: client.id, client_name: 'JK Cement', started_at: iso(-60_000), duration_seconds: 0 },
    { id: crypto.randomUUID(), direction: 'outgoing', number: '+919876543210', client_id: client.id, client_name: 'JK Cement', started_at: iso(-3 * 86_400_000), duration_seconds: 500 },
  ]);
  await store.saveMeeting({ client_id: client.id, client_name: 'JK Cement', meeting_at: new Date().toISOString() });
  await store.saveExpense({ category: 'fuel', bill_type: 'with_bill', work_area: 'local', amount_paise: 45000, expense_date: day(), note: '' });
  const e = await store.saveEnquiry(input());
  await store.saveEnquiry(input({ client_name: 'Old Co', id: undefined }));

  const f = figuresFor(store, day());
  assert.deepEqual(f, { calls: 2, calls_missed: 1, talk_seconds: 120, meetings: 1, enquiries_new: 2, enquiries_worked: 2, expenses_paise: 45000 });
  assert.equal(enquiriesWorked(store, day()).length, 2);
  assert.ok(e);
  assert.equal(figuresFor(store, day(-3)).calls, 1);
});

test('a report is one per day, can be corrected, and reaches the office once', async () => {
  const a = await phone();
  const today = day();
  const id = await reportId('REP001', today);

  await a.store.saveReport({ id, report_date: today, notes: 'Visited JK Cement', tomorrow_plan: 'Send prices', issues: '', figures: { calls: 5, meetings: 1 } });
  assert.equal(a.store.reportFor(today).submitted_at, null, 'a draft is not a submitted report');

  const sent = await a.store.saveReport({ id, report_date: today, notes: 'Visited JK Cement and Shree', figures: { calls: 5, meetings: 1 }, submit: true });
  assert.ok(sent.submitted_at);
  assert.equal(a.store.reports.length, 1);

  await a.engine.syncNow();
  assert.equal(office.count('reports'), 1);
  assert.equal(a.store.unsyncedCount, 0);

  // asking for another id for the same day still gives the one report
  const other = await a.store.saveReport({ id: crypto.randomUUID(), report_date: today, notes: 'Corrected', submit: true });
  assert.equal(other.id, id);
  assert.equal(other.submitted_at, sent.submitted_at, 'the first send time stays');
  assert.equal(a.store.reports.length, 1);

  await a.engine.syncNow();
  assert.equal(office.rows.reports.get(id).data.notes, 'Corrected');

  const again = await phone({ code: 'REP001' });
  await again.engine.syncNow();
  assert.equal(again.store.reportFor(today).notes, 'Corrected');
});

test('a report for a day that has not come, or is too old, is refused', async () => {
  const { store } = await phone();
  const id = crypto.randomUUID();

  await assert.rejects(store.saveReport({ id, report_date: day(5), notes: '' }), ValidationError);
  await assert.rejects(store.saveReport({ id, report_date: day(-40), notes: '' }), ValidationError);
  await assert.rejects(store.saveReport({ id, report_date: 'today', notes: '' }), ValidationError);
  await assert.rejects(store.saveReport({ id, report_date: day(), notes: 'x'.repeat(2001) }), ValidationError);
  await assert.rejects(store.saveReport({ id: 'nope', report_date: day(), notes: '' }), ValidationError);
  assert.equal(store.reports.length, 0);
});

test('what the office sends for a report is checked', () => {
  const good = { uuid: crypto.randomUUID(), report_date: '2026-10-27', notes: 'ok', figures: { calls: 3, meetings: -1 }, updated_at: iso(0) };

  assert.equal(cleanReport(good).figures.calls, 3);
  assert.equal(cleanReport(good).figures.meetings, 0, 'a bad number becomes 0');
  assert.equal(cleanReport({ ...good, report_date: 'x' }), null);
  assert.equal(cleanReport({ ...good, uuid: 'x' }), null);
});
