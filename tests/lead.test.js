import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  LEAD_STATUSES, LEAD_VIEWS, MAX_REMARK, byRecent, closesTo, filterLeads, inView, isLeadStatus, leadCounts, leadLabel, leadLine, matches, suggestedReminder,
} from '../src/core/lead.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanEnquiry } from '../src/sync/merge.js';
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
  return { store, engine };
}

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 86_400_000;

const input = (extra = {}) => ({
  client_name: 'JK Cement',
  status: 'qualification',
  items: [{ product: 'Muffle Furnace', brands: '', quantity: 1, budget_paise: 1_500_000 }],
  ...extra,
});

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  key = await aesKey(randomBytes(32));
});

// ---- the pure part --------------------------------------------------------------------------------------------------

test('the ten statuses, their words and which ones finish the enquiry', () => {
  assert.deepEqual(LEAD_STATUSES.map((s) => s.value), ['new', 'price_sent', 'better_option', 'call_not_picking', 'want_less_price', 'interested', 'waiting', 'not_interested', 'deal_done', 'deal_lost']);
  assert.equal(leadLabel('better_option'), 'Asked for better option');
  assert.equal(leadLabel(null), 'New lead', 'an enquiry from before v1.15 reads as a new lead');
  assert.equal(closesTo('deal_done'), 'won');
  assert.equal(closesTo('deal_lost'), 'lost');
  assert.equal(closesTo('price_sent'), null);
  assert.ok(isLeadStatus('waiting'));
  assert.ok(!isLeadStatus('nonsense') && !isLeadStatus(null));
});

test('suggested reminders: a day count at 10 am, three hours for "call not picking" but never at night, none for the finishing statuses', () => {
  const at = (h, m = 0) => new Date(2026, 10, 5, h, m);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  assert.equal(fmt(suggestedReminder('price_sent', at(14))), '11/8 10:00');
  assert.equal(fmt(suggestedReminder('better_option', at(14))), '11/6 10:00');
  assert.equal(fmt(suggestedReminder('waiting', at(14))), '11/12 10:00');
  assert.equal(fmt(suggestedReminder('call_not_picking', at(10, 30))), '11/5 13:30');
  assert.equal(fmt(suggestedReminder('call_not_picking', at(17))), '11/6 10:00', '8 pm is too late: next morning');
  assert.equal(fmt(suggestedReminder('call_not_picking', at(22))), '11/6 10:00');
  assert.equal(fmt(suggestedReminder('call_not_picking', at(2))), '11/5 10:00', 'before 9 am: the same morning at 10');
  assert.equal(suggestedReminder('deal_done'), null);
  assert.equal(suggestedReminder('deal_lost'), null);
});

test('the four views: today is what needs action, week and month are by the day it was opened, all is everything', () => {
  const now = new Date();
  const e = (extra) => ({ status: 'qualification', client_name: 'X', items: [], opened_at: iso(-2 * DAY), updated_at: iso(-3_600_000), next_followup_at: iso(3 * DAY), ...extra });
  const late = e({ id: 'late', next_followup_at: iso(-3_600_000) });
  const planned = e({ id: 'planned' });
  const idle = e({ id: 'idle', next_followup_at: null, updated_at: iso(-5 * DAY), opened_at: iso(-6 * DAY) });
  const older = e({ id: 'older', opened_at: iso(-20 * DAY) });
  const wonOld = e({ id: 'won', status: 'won', next_followup_at: null, opened_at: iso(-60 * DAY) });
  const list = [late, planned, idle, older, wonOld];

  const ids = (view) => filterLeads(list, view, now).map((x) => x.id).sort();
  assert.deepEqual(ids('today'), ['idle', 'late']);
  assert.deepEqual(ids('week'), ['idle', 'late', 'planned']);
  assert.deepEqual(ids('month'), ['idle', 'late', 'older', 'planned']);
  assert.equal(ids('all').length, 5);
  assert.deepEqual(leadCounts(list, now), { today: 2, week: 3, month: 4, all: 5 });
  assert.deepEqual(LEAD_VIEWS.map((v) => v.value), ['today', 'week', 'month', 'all']);
  assert.equal(inView(wonOld, 'today', now), false);
});

test('newest activity first, search by client, product, remark and status words, and the timeline line', () => {
  const a = { id: 'a', opened_at: iso(-9 * DAY), updated_at: iso(-8 * DAY), last_followup_at: iso(-1_000) };
  const b = { id: 'b', opened_at: iso(-1 * DAY), updated_at: iso(-1 * DAY), last_followup_at: null };
  const c = { id: 'c', opened_at: iso(-3 * DAY), updated_at: iso(-2 * DAY), last_followup_at: null };
  assert.deepEqual([c, b, a].sort(byRecent).map((x) => x.id), ['a', 'b', 'c']);

  const lead = { client_name: 'JK Cement', contact_name: 'Rohit', lead_status: 'price_sent', lead_remark: 'Wants it by Friday', items: [{ product: 'Muffle Furnace', brands: 'Remi' }] };
  for (const word of ['jk', 'rohit', 'furnace', 'remi', 'friday', 'price sent', '']) assert.ok(matches(lead, word), word);
  assert.ok(!matches(lead, 'centrifuge'));

  assert.equal(leadLine('price_sent', ' will confirm '), 'Follow-up: Price sent: will confirm');
  assert.equal(leadLine('call_not_picking', ''), 'Follow-up: Call not picking');
});

// ---- the store ------------------------------------------------------------------------------------------------------

test('a new enquiry is a new lead with its first reminder tomorrow at 10 am; an edit keeps what is stored', async () => {
  const { store } = await phone();
  const e = await store.saveEnquiry(input());
  assert.equal(e.lead_status, 'new');
  assert.equal(e.lead_remark, '');
  assert.equal(e.last_followup_at, null);
  const at = new Date(e.next_followup_at);
  assert.equal(at.getHours(), 10);
  assert.ok(at.getTime() > Date.now() && at.getTime() < Date.now() + 2 * DAY);

  const logged = await store.saveLeadFollowup({ id: e.id, lead_status: 'price_sent', remark: 'Quoted', next_followup_at: iso(3 * DAY) });
  const edited = await store.saveEnquiry({ ...input({ client_name: 'JK Cement Ltd' }), id: e.id });
  assert.equal(edited.next_followup_at, logged.next_followup_at, 'the edit form says nothing about the reminder: it stays');
  assert.deepEqual([edited.lead_status, edited.lead_remark], ['price_sent', 'Quoted']);

  const none = await store.saveEnquiry(input({ client_name: 'No Reminder Ltd', next_followup_at: null }));
  assert.equal(none.next_followup_at, null, 'null said on purpose is no reminder');
});

test('a follow-up sets status, remark, last contact, reminder and one timeline line, and clears the unsent mark', async () => {
  const { store } = await phone();
  const e = await store.saveEnquiry(input());
  const when = iso(2 * DAY);

  const r = await store.saveLeadFollowup({ id: e.id, lead_status: 'better_option', remark: '  Asked for a cheaper brand  ', next_followup_at: when });

  assert.equal(r.lead_status, 'better_option');
  assert.equal(r.lead_remark, 'Asked for a cheaper brand');
  assert.equal(r.next_followup_at, new Date(when).toISOString());
  assert.ok(r.last_followup_at);
  assert.equal(r.status, 'qualification', 'the stage does not move for an open status');
  assert.equal(r.timeline.at(-1).text, 'Follow-up: Asked for better option: Asked for a cheaper brand');
  assert.equal(r.timeline.length, e.timeline.length + 1);
  assert.equal(r.synced, false);
  assert.equal(store.enquiryById(e.id).lead_remark, 'Asked for a cheaper brand');
});

test('Deal done and Deal lost finish the enquiry: the stage, no reminder, a close time', async () => {
  const { store } = await phone();
  const won = await store.saveLeadFollowup({ id: (await store.saveEnquiry(input())).id, lead_status: 'deal_done', remark: 'PO received' });
  assert.equal(won.status, 'won');
  assert.equal(won.next_followup_at, null);
  assert.ok(won.closed_at);
  assert.equal(won.lead_status, 'deal_done');

  const lost = await store.saveLeadFollowup({ id: (await store.saveEnquiry(input({ client_name: 'Other Lab' }))).id, lead_status: 'deal_lost', remark: '', next_followup_at: iso(DAY) });
  assert.equal(lost.status, 'lost');
  assert.equal(lost.next_followup_at, null, 'a reminder given for a finished lead is dropped');
});

test('the rules: a status, a reminder (or "no reminder"), a short remark, no past, at most two years, nothing on a finished enquiry', async () => {
  const { store } = await phone();
  const e = await store.saveEnquiry(input());
  const bad = (patch) => assert.rejects(store.saveLeadFollowup({ id: e.id, lead_status: 'price_sent', remark: 'x', next_followup_at: iso(DAY), ...patch }), ValidationError, JSON.stringify(patch));

  await bad({ lead_status: 'nonsense' });
  await bad({ lead_status: null });
  await bad({ next_followup_at: null });
  await bad({ next_followup_at: 'soon' });
  await bad({ next_followup_at: iso(-3 * DAY) });
  await bad({ next_followup_at: iso(3 * 365 * DAY) });
  await bad({ remark: 'y'.repeat(MAX_REMARK + 1) });
  await bad({ remark: 'bad \u0007 char' });
  await assert.rejects(store.saveLeadFollowup({ id: 'no-such-id', lead_status: 'new', next_followup_at: iso(DAY) }), ValidationError);
  assert.equal(store.enquiryById(e.id).lead_status, 'new', 'nothing was saved by a refused follow-up');

  const waiting = await store.saveLeadFollowup({ id: e.id, lead_status: 'waiting', remark: 'later', no_reminder: true });
  assert.equal(waiting.next_followup_at, null, '"no reminder" is allowed when said on purpose');

  const finished = await store.saveEnquiry(input({ client_name: 'Done Ltd', status: 'won' }));
  await assert.rejects(store.saveLeadFollowup({ id: finished.id, lead_status: 'interested', remark: 'x', next_followup_at: iso(DAY) }), ValidationError);
});

test('moving the stage in the form keeps the lead status in step', async () => {
  const { store } = await phone();
  const e = await store.saveEnquiry(input());
  const won = await store.saveEnquiry({ ...input(), id: e.id, status: 'won' });
  assert.equal(won.lead_status, 'deal_done');
  const reopened = await store.saveEnquiry({ ...input(), id: e.id, status: 'negotiation' });
  assert.equal(reopened.lead_status, 'new', 'a reopened enquiry is a new lead again');
});

// ---- sync -----------------------------------------------------------------------------------------------------------

test('the follow-up reaches the office and comes back on a new phone', async () => {
  const persist = new MemoryPersist();
  const a = await phone({ persist });
  const e = await a.store.saveEnquiry(input());
  await a.store.saveLeadFollowup({ id: e.id, lead_status: 'price_sent', remark: 'Quoted 1.5 lakh', next_followup_at: iso(3 * DAY) });
  await a.engine.syncNow();

  const row = office.rows.enquiries.get(e.id).data;
  assert.deepEqual([row.lead_status, row.lead_remark], ['price_sent', 'Quoted 1.5 lakh']);
  assert.ok(row.last_followup_at);

  const b = await phone({ persist: new MemoryPersist() });
  await b.engine.syncNow();
  const back = b.store.enquiryById(e.id);
  assert.deepEqual([back.lead_status, back.lead_remark], ['price_sent', 'Quoted 1.5 lakh']);
  assert.ok(back.last_followup_at);
});

test('an office from before v1.15 (no lead fields) never wipes what the rep logged', async () => {
  office.ignoresLead = true;
  const { store, engine } = await phone();
  const e = await store.saveEnquiry(input());
  await store.saveLeadFollowup({ id: e.id, lead_status: 'waiting', remark: 'After Diwali', next_followup_at: iso(5 * DAY) });
  await engine.syncNow();
  assert.equal('lead_status' in office.rows.enquiries.get(e.id).data, false, 'the old office kept no such field');

  // the office changes the enquiry (a newer copy without the keys): the phone keeps its own lead fields
  const row = office.rows.enquiries.get(e.id);
  row.data = { ...row.data, client_name: 'JK Cement Ltd (office)', updated_at: iso(60_000) };
  row.rev = ++office.rev;
  await engine.syncNow();

  const now = store.enquiryById(e.id);
  assert.equal(now.client_name, 'JK Cement Ltd (office)');
  assert.deepEqual([now.lead_status, now.lead_remark], ['waiting', 'After Diwali']);
});

test('what comes from the office is cleaned: a made-up status, a long remark and a bad time are dropped', () => {
  const base = {
    uuid: crypto.randomUUID(), client_name: 'JK Cement', status: 'qualification', items: [{ product: 'Muffle Furnace', quantity: 1 }],
    opened_at: iso(-DAY), updated_at: iso(-1000),
  };
  const good = cleanEnquiry({ ...base, lead_status: 'price_sent', lead_remark: 'ok', last_followup_at: iso(-5000) });
  assert.deepEqual([good.lead_status, good.lead_remark], ['price_sent', 'ok']);
  assert.ok(good.last_followup_at);

  const odd = cleanEnquiry({ ...base, lead_status: 'hacked', lead_remark: 'z'.repeat(1000), last_followup_at: 'never' });
  assert.equal(odd.lead_status, null);
  assert.equal(odd.lead_remark.length, MAX_REMARK);
  assert.equal(odd.last_followup_at, null);

  const old = cleanEnquiry(base);
  assert.deepEqual([old.lead_status, old.lead_remark, old.last_followup_at], [null, '', null], 'an office without the fields: defaults');
});
