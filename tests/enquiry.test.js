import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  SOURCES, addBudget, askedBrands, askedProducts, byUrgency, daysAgo, frequentBrands, groupRupees, guideBrands, isSource, itemsSummary, lastVisit, needsAction, openEnquiriesOf,
  recentClients, searchClients, shortMoney, sourceLabel, splitBrands, urgency,
} from '../src/core/enquiry.js';
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
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement', phone: '98765 43210' });
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

// ---- "came through" (source) ---------------------------------------------------------------------------

test('source: only the four ways, or nothing', async () => {
  const { store } = await phone();

  for (const value of ['call', 'walkin', 'whatsapp', 'reference', null]) {
    const e = await store.saveEnquiry(input({ client_name: `Client ${value}`, source: value }));
    assert.equal(e.source, value);
  }
  assert.deepEqual(SOURCES.map((x) => x.value), ['call', 'walkin', 'whatsapp', 'reference']);
  assert.equal(sourceLabel('walkin'), 'Walk-in');
  assert.equal(isSource('fax'), false);

  const before = store.enquiries.length;
  for (const bad of ['fax', '', 'CALL', 5, {}, false]) await assert.rejects(store.saveEnquiry(input({ source: bad })), ValidationError, String(bad));
  assert.equal(store.enquiries.length, before, 'nothing wrong was saved');
});

test('source: a save that says nothing keeps it, null clears it, and a new enquiry starts empty', async () => {
  const { store } = await phone();
  const fresh = await store.saveEnquiry(input());
  assert.equal(fresh.source, null, 'an enquiry without the field has none');

  const e = await store.saveEnquiry({ ...input(), id: fresh.id, source: 'whatsapp' });
  assert.equal((await store.saveEnquiry({ ...input(), id: e.id, note: 'Called him' })).source, 'whatsapp', 'left out = kept');
  assert.equal((await store.saveEnquiry({ ...input(), id: e.id, source: null })).source, null, 'null = cleared');
});

test('source: sent with the enquiry (null when there is none), comes back on a new phone, and an old office does not break anything', async () => {
  const a = await phone();
  const plain = await a.store.saveEnquiry(input({ client_name: 'Plain Co' }));
  const via = await a.store.saveEnquiry(input({ client_name: 'Via Co', source: 'call' }));
  await a.engine.syncNow();

  const sent = office.calls.filter((c) => c.path === '/sync/push').flatMap((c) => c.body.enquiries ?? []);
  assert.equal(sent.find((e) => e.uuid === plain.id).source, null, 'null is sent: that is how clearing a choice reaches the office');
  assert.equal(sent.find((e) => e.uuid === via.id).source, 'call');
  assert.equal(office.rows.enquiries.get(via.id).data.source, 'call');
  assert.equal(a.store.unsyncedCount, 0);

  const again = await phone({ code: 'REP001' });
  await again.engine.syncNow();
  assert.equal(again.store.enquiryById(via.id).source, 'call');
  assert.equal(again.store.enquiryById(plain.id).source, null);

  // an office that does not know the field: it keeps none and sends none; the phone must not lose what the rep chose
  office.ignoresSource = true;
  await new Promise((r) => setTimeout(r, 5));
  await again.store.saveEnquiry({ ...input({ client_name: 'Via Co' }), id: via.id, source: 'reference', note: 'Updated' });
  await again.engine.syncNow();
  assert.equal(again.store.unsyncedCount, 0, 'the old office accepted it');
  assert.equal('source' in office.rows.enquiries.get(via.id).data, false);
  assert.equal(again.store.enquiryById(via.id).source, 'reference', 'and the pull of the old office does not wipe it');
});

test('source: what the office sends is checked; a missing field is none', () => {
  const good = { uuid: crypto.randomUUID(), client_name: 'JK', status: 'new', items: [{ product: 'Oven', quantity: 1 }], opened_at: iso(0), updated_at: iso(0), timeline: [] };

  assert.equal(cleanEnquiry(good).source, null);
  assert.equal(cleanEnquiry({ ...good, source: 'whatsapp' }).source, 'whatsapp');
  assert.equal(cleanEnquiry({ ...good, source: 'carrier pigeon' }).source, null);
  assert.equal(cleanEnquiry({ ...good, source: 7 }).source, null);
  assert.equal(cleanEnquiry({ ...good, source: '<b>x</b>' }).source, null);
});

test('source: an enquiry stored before the field existed loads with none', async () => {
  const { store } = await phone();
  const old = cleanEnquiry({ uuid: crypto.randomUUID(), client_name: 'Old Co', status: 'new', items: [{ product: 'Oven', quantity: 1 }], opened_at: iso(-86_400_000), updated_at: iso(-86_400_000), timeline: [] });
  delete old.source;

  await store.putFromServer('enquiry', old);
  assert.equal(store.enquiryById(old.id).source, null);
});

// ---- helpers of the three-step form ---------------------------------------------------------------------

const when = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const client = (n, name, city = '') => ({ id: `c${n}`, name, city });
const enq = (client_id, days, items, status = 'new', id = crypto.randomUUID()) => ({ id, client_id, status, items, opened_at: when(days), updated_at: when(days) });
const item = (product, brands = '') => ({ product, brands, quantity: 1 });

test('recent clients: newest first, once each, only ones that still exist, at most five', () => {
  const clients = [1, 2, 3, 4, 5, 6, 7].map((n) => client(n, `Client ${n}`));
  const enquiries = [enq('c1', 9, [item('A')]), enq('c2', 1, [item('A')]), enq('c2', 5, [item('A')]), enq('gone', 0, [item('A')]), enq(null, 0, [item('A')])];
  const meetings = [{ client_id: 'c3', meeting_at: when(2) }, { client_id: 'c4', meeting_at: when(3) }, { client_id: 'c5', meeting_at: when(4) }, { client_id: 'c6', meeting_at: when(6) }, { client_id: 'c7', meeting_at: when(-3) }];

  const list = recentClients({ enquiries, meetings, clients });
  assert.deepEqual(list.map((r) => r.client.id), ['c2', 'c3', 'c4', 'c5', 'c6'], 'c1 is sixth; c7 (a meeting still to come) does not count; a deleted client is skipped');
  assert.equal(recentClients({ enquiries, meetings, clients, max: 2 }).length, 2);
  assert.deepEqual(recentClients({}), []);
});

test('last visit and "N days ago"', () => {
  const now = new Date();
  const meetings = [{ client_id: 'c1', meeting_at: when(10) }, { client_id: 'c1', meeting_at: when(3) }, { client_id: 'c1', meeting_at: when(-4) }, { client_id: 'c2', meeting_at: when(1) }];

  assert.equal(daysAgo(lastVisit(meetings, 'c1', now), now), '3 days ago');
  assert.equal(lastVisit(meetings, 'c9', now), null);
  assert.equal(daysAgo(now, now), 'today');
  assert.equal(daysAgo(new Date(now.getTime() - 86_400_000), now), 'yesterday');
});

test('client search: name or town, starts-with first, at most eight', () => {
  const clients = [client(1, 'Alwar Pharma', 'Alwar'), client(2, 'JK Cement', 'Jaipur'), client(3, 'Mahesh Chemicals', 'Kota'), client(4, 'Jaipur Dairy Lab', 'Jaipur')];

  assert.deepEqual(searchClients(clients, 'jaipur').map((c) => c.name), ['Jaipur Dairy Lab', 'JK Cement'], 'a name that starts with it first');
  assert.deepEqual(searchClients(clients, 'KOTA').map((c) => c.name), ['Mahesh Chemicals']);
  assert.deepEqual(searchClients(clients, 'zzz'), []);
  assert.deepEqual(searchClients(clients, '  '), []);
  assert.equal(searchClients(Array.from({ length: 20 }, (_, n) => client(n, `Lab ${n}`)), 'lab').length, 8);
});

test('asked products: most frequent first, the same product once whatever the spelling', () => {
  const enquiries = [
    enq('c1', 1, [item('Hot Air Oven'), item('Muffle Furnace')]),
    enq('c2', 2, [item('hot air oven'), item('Balance')]),
    enq('c3', 3, [item('Hot Air Oven'), item('Autoclave'), item('Autoclave')]),
  ];

  assert.deepEqual(askedProducts(enquiries), ['Hot Air Oven', 'Autoclave', 'Muffle Furnace', 'Balance'], 'oven x3, autoclave x2, then the newest of the single ones');
  assert.deepEqual(askedProducts([]), []);
});

test('asked brands for a product, and the guide brands of the same product', () => {
  const enquiries = [
    enq('c1', 1, [item('Muffle Furnace', 'Labtech, Remi')]),
    enq('c2', 2, [item('muffle furnace', 'remi')]),
    enq('c3', 3, [item('Hot Air Oven', 'Local')]),
  ];
  const guide = [{ name: 'Muffle Furnace', premium_brands: ['Nabertherm'], economy_brands: ['Labtech'], lite_brands: [] }, { name: 'Oven', premium_brands: [], economy_brands: ['X'] }];

  assert.deepEqual(askedBrands(enquiries, 'Muffle Furnace'), ['Remi', 'Labtech'], 'Remi twice, Labtech once');
  assert.deepEqual(askedBrands(enquiries, 'Nothing'), []);
  assert.deepEqual(askedBrands(enquiries, ''), []);
  assert.deepEqual(guideBrands(guide, 'muffle furnace'), ['Nabertherm', 'Labtech']);
  assert.deepEqual(guideBrands(guide, 'Oven'), ['X'], 'a guide product with a tier missing still works');
  assert.deepEqual(guideBrands(guide, 'Unknown'), []);
  assert.deepEqual(splitBrands('Remi,  labtech, REMI ,'), ['REMI', 'labtech']);
});

test('open enquiries of a client: only open ones, newest first, not the one being edited', () => {
  const enquiries = [
    enq('c1', 5, [item('A')], 'new', 'old'),
    enq('c1', 1, [item('B')], 'price_sent', 'new'),
    enq('c1', 2, [item('C')], 'won', 'closed'),
    enq('c2', 0, [item('D')], 'new', 'other'),
  ];

  assert.deepEqual(openEnquiriesOf(enquiries, 'c1').map((e) => e.id), ['new', 'old']);
  assert.deepEqual(openEnquiriesOf(enquiries, 'c1', 'new').map((e) => e.id), ['old']);
  assert.deepEqual(openEnquiriesOf(enquiries, null), []);
  assert.deepEqual(openEnquiriesOf(enquiries, 'c3'), []);
});

test('short money: K, L and Cr', () => {
  assert.equal(shortMoney(340000), '₹3.4L');
  assert.equal(shortMoney(50000), '₹50K');
  assert.equal(shortMoney(12500000), '₹1.25Cr');
  assert.equal(shortMoney(200000), '₹2L');
  assert.equal(shortMoney(245000), '₹2.45L');
  assert.equal(shortMoney(999), '₹999');
  assert.equal(shortMoney(12500), '₹12.5K');
  assert.equal(shortMoney(99999), '₹1L', 'never "100K"');
  assert.equal(shortMoney(0), '₹0');
  assert.equal(shortMoney(-5), '₹0');
  assert.equal(shortMoney('abc'), '₹0');
});

test('budget chips add to what is typed, and the box shows Indian grouping', () => {
  assert.equal(addBudget('', 100000), '100000');
  assert.equal(addBudget(addBudget('', 100000), 100000), '200000', '+1L twice = 2,00,000');
  assert.equal(addBudget('3,00,000', 50000), '350000');
  assert.equal(addBudget('1500.50', 50000), '51500.5');
  assert.equal(addBudget('abc', 50000), '50000', 'text that is not a number counts as nothing');
  assert.equal(addBudget('9900000', 500000), '9999999', 'never above what the budget box can hold');

  assert.equal(groupRupees('300000'), '3,00,000');
  assert.equal(groupRupees('1234'), '1,234');
  assert.equal(groupRupees('999'), '999');
  assert.equal(groupRupees('1234567'), '12,34,567');
  assert.equal(groupRupees('150000.5'), '1,50,000.5');
  assert.equal(groupRupees('3,00,000'), '3,00,000');
  assert.equal(groupRupees(''), '');
  assert.equal(groupRupees('1.2.3'), '1.2.3', 'not a number: left alone for the check to refuse');
});

test('frequent brands: the ones the rep writes most, over all products, even before a product is chosen', () => {
  const enquiries = [
    enq('c1', 1, [item('Muffle Furnace', 'Labtech, Remi')]),
    enq('c2', 2, [item('Hot Air Oven', 'remi')]),
    enq('c3', 3, [item('Balance', 'Remi, Local')]),
  ];

  const got = frequentBrands(enquiries);
  assert.equal(got[0], 'Remi', 'Remi was written three times');
  assert.deepEqual([...got].sort(), ['Labtech', 'Local', 'Remi']);
  assert.equal(frequentBrands(enquiries, 2).length, 2);
  assert.deepEqual(frequentBrands([]), []);
});
