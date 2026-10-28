import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { MAX_STOPS, isOpen, spaceTimes, timeOf } from '../src/core/meeting.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanRoute } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

// Routes: several meetings of one day as one trip. The rules the store keeps, and how routes travel to the office and back.

const BASE = 'https://office.example/api/sales/v1';
let office;
let key;

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

const day = (n = 0, hh = 10, mm = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hh, mm, 0, 0);
  return d;
};
const key2 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function phone({ code = 'REP001', persist = new MemoryPersist() } = {}) {
  const store = await Store.open(persist, key);
  if (!store.profile) await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '2.0', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine };
}

const stop = (store, name, n = 0, hh = 10, extra = {}) => store.saveMeeting({
  client_name: name, meeting_at: day(n, hh).toISOString(), scheduled_at: day(n, hh).toISOString(), status: 'planned', ...extra,
});

// three planned stops in one day
async function threeStops(store, n = 1) {
  const a = await stop(store, 'Alpha Industries', n, 10);
  const b = await stop(store, 'Beta Chemicals', n, 12);
  const c = await stop(store, 'Gamma Labs', n, 15);
  return [a, b, c];
}

// ---- making a route ----------------------------------------------------------------------------------------

test('a route holds the meetings of one day in an order; the stops point back at it', async () => {
  const { store } = await phone();
  const [a, b, c] = await threeStops(store);
  const route = await store.saveRoute({ area: 'Bhiwadi', stops_order: [b.id, a.id, c.id] });

  assert.equal(route.title, 'Bhiwadi run', 'the title starts as "<place> run"');
  assert.equal(route.date, key2(day(1)));
  assert.equal(route.rep_id, 'REP001');
  assert.deepEqual(route.stops_order, [b.id, a.id, c.id]);
  assert.equal(route.start_time, '10:00', 'the earliest stop');
  assert.equal(route.overnight, false);
  assert.ok(route.id);
  for (const s of [a, b, c]) assert.equal(store.meetingById(s.id).route_id, route.id);

  assert.deepEqual(store.routeStops(route.id).map((s) => s.client_name), ['Beta Chemicals', 'Alpha Industries', 'Gamma Labs']);
  assert.equal(store.routes.length, 1);
  assert.equal(store.routeById(route.id).title, 'Bhiwadi run');
});

test('a route needs 1 to 10 stops, all on the same day, and a stop cannot be in two routes', async () => {
  const { store } = await phone();
  const [a, b] = await threeStops(store);
  const elsewhere = await stop(store, 'Other Day Co', 5, 10);

  await assert.rejects(store.saveRoute({ stops_order: [] }), /at least one/);
  await assert.rejects(store.saveRoute({ stops_order: ['nope'] }), /not on this phone/);
  await assert.rejects(store.saveRoute({ stops_order: [a.id, elsewhere.id] }), /same day/);
  await assert.rejects(store.saveRoute({ title: 'x', stops_order: [a.id] }), ValidationError);
  await assert.rejects(store.saveRoute({ title: 'Bad <name>', stops_order: [a.id] }), ValidationError);
  await assert.rejects(store.saveRoute({ start_time: '25:00', stops_order: [a.id] }), /start time/);
  assert.equal(store.routes.length, 0, 'nothing wrong was saved');

  const one = await store.saveRoute({ stops_order: [a.id] });
  assert.equal(one.stops_order.length, 1, 'one stop is a route');
  await assert.rejects(store.saveRoute({ stops_order: [a.id, b.id] }), /already in another route/);

  const many = [];
  for (let i = 0; i < MAX_STOPS + 1; i++) many.push((await stop(store, `Client number ${i}`, 7, 9 + (i % 8))).id);
  await assert.rejects(store.saveRoute({ stops_order: many }), /at most 10/);
  assert.ok(await store.saveRoute({ stops_order: many.slice(0, MAX_STOPS) }), 'ten is fine');
});

test('a stop joins a route when it is saved with the route id: same day only, and with room', async () => {
  const { store } = await phone();
  const [a, b] = await threeStops(store);
  const route = await store.saveRoute({ title: 'Alwar run', stops_order: [a.id, b.id] });

  const joined = await stop(store, 'Delta Pharma', 1, 17, { route_id: route.id });
  assert.equal(joined.route_id, route.id);
  assert.deepEqual(store.routeById(route.id).stops_order, [a.id, b.id, joined.id], 'it comes last');

  await assert.rejects(stop(store, 'Wrong Day Co', 3, 10, { route_id: route.id }), /one day only/);
  await assert.rejects(stop(store, 'Ghost Route Co', 1, 18, { route_id: 'not-a-route' }), /does not exist/);

  for (let i = 0; store.routeById(route.id).stops_order.length < MAX_STOPS; i++) await stop(store, `Filler number ${i}`, 1, 9, { route_id: route.id });
  await assert.rejects(stop(store, 'One Too Many', 1, 9, { route_id: route.id }), /at most 10/);
});

// ---- leaving a route ---------------------------------------------------------------------------------------

test('moving a stop to another day pulls it out of the route', async () => {
  const { store } = await phone();
  const [a, b, c] = await threeStops(store);
  const route = await store.saveRoute({ stops_order: [a.id, b.id, c.id] });

  const moved = await store.saveMeeting({ ...store.meetingById(b.id), id: b.id, meeting_at: day(4, 11).toISOString(), scheduled_at: day(4, 11).toISOString(), status: 'moved', moved_from: b.scheduled_at });
  assert.equal(moved.route_id, null);
  assert.equal(moved.status, 'moved');
  assert.deepEqual(store.routeById(route.id).stops_order, [a.id, c.id]);

  // the same day: it stays
  const later = await store.saveMeeting({ ...store.meetingById(c.id), id: c.id, meeting_at: day(1, 16).toISOString(), scheduled_at: day(1, 16).toISOString(), status: 'moved' });
  assert.equal(later.route_id, route.id);
});

test('deleting the last stop deletes the route; deleting another leaves it', async () => {
  const { store } = await phone();
  const [a, b] = await threeStops(store);
  const route = await store.saveRoute({ stops_order: [a.id, b.id] });

  await store.deleteMeeting(a.id);
  assert.deepEqual(store.routeById(route.id).stops_order, [b.id]);
  await store.deleteMeeting(b.id);
  assert.equal(store.routeById(route.id), null);
  assert.equal(store.routes.length, 0);

  // a stop that moves out and was the last one: the route goes too
  const [x, y] = [await stop(store, 'X Industries', 2, 10), await stop(store, 'Y Industries', 2, 12)];
  const second = await store.saveRoute({ stops_order: [x.id, y.id] });
  await store.saveMeeting({ ...store.meetingById(x.id), id: x.id, meeting_at: day(9).toISOString(), scheduled_at: day(9).toISOString() });
  await store.saveMeeting({ ...store.meetingById(y.id), id: y.id, meeting_at: day(9, 14).toISOString(), scheduled_at: day(9, 14).toISOString() });
  assert.equal(store.routeById(second.id), null);
});

test('deleting a route keeps its meetings as single meetings', async () => {
  const { store } = await phone();
  const [a, b] = await threeStops(store);
  const route = await store.saveRoute({ stops_order: [a.id, b.id] });

  await store.deleteRoute(route.id);
  assert.equal(store.routeById(route.id), null);
  assert.equal(store.meetings.length, 3);
  assert.equal(store.meetingById(a.id).route_id, null);
  assert.equal(store.meetingById(b.id).route_id, null);
  await store.deleteRoute('not-there'); // nothing happens
});

test('taking a stop out of the order frees it, and a rename keeps the stops', async () => {
  const { store } = await phone();
  const [a, b, c] = await threeStops(store);
  const route = await store.saveRoute({ stops_order: [a.id, b.id, c.id] });

  await store.saveRoute({ id: route.id, stops_order: [c.id, a.id] });
  assert.equal(store.meetingById(b.id).route_id, null);
  assert.deepEqual(store.routeStops(route.id).map((s) => s.id), [c.id, a.id]);

  const renamed = await store.saveRoute({ id: route.id, title: 'Jaipur outskirts', stops_order: [c.id, a.id] });
  assert.equal(renamed.title, 'Jaipur outskirts');
  assert.equal(renamed.created_at, route.created_at);
});

// ---- the times ---------------------------------------------------------------------------------------------

test('reordering recalculates the stops that have not happened yet, and leaves the logged ones and hand-set times alone', async () => {
  const { store } = await phone();
  const a = await stop(store, 'Alpha Industries', 0, 9, { time_manual: false });
  const b = await stop(store, 'Beta Chemicals', 0, 11);
  const c = await stop(store, 'Gamma Labs', 0, 13, { time_manual: true });
  const d = await stop(store, 'Delta Pharma', 0, 15);
  const route = await store.saveRoute({ stops_order: [a.id, b.id, c.id, d.id], start_time: '09:00' });

  // Alpha is done (it keeps the time it really happened)
  await store.saveMeeting({ ...store.meetingById(a.id), id: a.id, status: 'done', meeting_at: day(0, 9, 20).toISOString(), scheduled_at: a.scheduled_at });

  const order = [d, b, c, a].map((x) => store.meetingById(x.id));
  const stops = order;
  const times = {};
  spaceTimes(stops, '09:00').forEach((at, i) => { if (isOpen(stops[i]) && at.getTime() !== timeOf(stops[i]).getTime()) times[stops[i].id] = at.toISOString(); });
  await store.saveRoute({ id: route.id, stops_order: order.map((x) => x.id), times });

  const hhmm = (id) => { const t = timeOf(store.meetingById(id)); return `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`; };
  assert.equal(hhmm(d.id), '9:00', 'first in the new order: the start time');
  assert.equal(hhmm(b.id), '10:30', '90 minutes after it');
  assert.equal(hhmm(c.id), '13:00', 'set by hand: never overwritten');
  assert.equal(hhmm(a.id), '9:20', 'already done: the time it happened');
  assert.deepEqual(store.routeById(route.id).stops_order, [d.id, b.id, c.id, a.id]);
});

test('a time in a route update that moves a stop to another day is refused', async () => {
  const { store } = await phone();
  const [a, b] = await threeStops(store);
  await assert.rejects(store.saveRoute({ stops_order: [a.id, b.id], times: { [b.id]: day(5, 10).toISOString() } }), /same day/);
});

// ---- the office --------------------------------------------------------------------------------------------

test('a route and its planned meetings reach the office and come back on a new phone', async () => {
  const a = await phone();
  const [s1, s2] = await threeStops(a.store);
  const route = await a.store.saveRoute({ title: 'Bhiwadi run', area: 'Bhiwadi', stops_order: [s1.id, s2.id], start_time: '10:00' });
  await a.engine.syncNow();

  assert.equal(office.count('routes'), 1);
  assert.equal(a.store.unsyncedCount, 0);
  const sent = office.rows.routes.get(route.id).data;
  assert.deepEqual([sent.title, sent.area, sent.date, sent.start_time, sent.stops_order], ['Bhiwadi run', 'Bhiwadi', key2(day(1)), '10:00', [s1.id, s2.id]]);
  assert.equal('rep_id' in sent, false, 'the office knows the rep from the sign-in');
  const meeting = office.rows.meetings.get(s1.id).data;
  assert.equal(meeting.status, 'planned');
  assert.equal(meeting.route_uuid, route.id);
  assert.equal(meeting.scheduled_at, s1.scheduled_at);

  const again = await phone({ code: 'REP001' });
  await again.engine.syncNow();
  assert.equal(again.store.routeById(route.id).title, 'Bhiwadi run');
  assert.deepEqual(again.store.routeStops(route.id).map((s) => s.id), [s1.id, s2.id]);
  assert.equal(again.store.meetingById(s1.id).status, 'planned');
  assert.equal(again.store.meetingById(s1.id).route_id, route.id);

  // a delete made there reaches the office
  await again.store.deleteRoute(route.id);
  await again.engine.syncNow();
  assert.equal(office.count('routes'), 0);
});

test('a rep only ever gets their own routes and meetings', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const [s1] = await threeStops(a.store);
  await a.store.saveRoute({ stops_order: [s1.id] });
  await a.engine.syncNow();
  await b.engine.syncNow();

  assert.equal(b.store.routes.length, 0);
  assert.equal(b.store.meetings.length, 0);
});

test('an old-style meeting sends none of the planning fields, and no routes key is sent when there is no route', async () => {
  const a = await phone();
  await a.store.saveMeeting({ client_name: 'Old Style Co', meeting_at: day(-1).toISOString() });
  await a.engine.syncNow();

  const bodies = office.calls.filter((c) => c.path === '/sync/push').map((c) => c.body);
  const meeting = bodies.flatMap((b) => b.meetings ?? [])[0];
  for (const field of ['status', 'scheduled_at', 'ended_at', 'route_uuid', 'result', 'moved_from', 'time_manual']) assert.equal(field in meeting, false, field);
  for (const body of bodies) {
    assert.equal('routes' in body, false, 'no routes key');
    assert.equal('routes' in (body.deleted ?? {}), false, 'no deleted routes key');
  }
});

test('a planned meeting that was logged tells the office it is done (and keeps its plan)', async () => {
  const a = await phone();
  const s = await stop(a.store, 'Alpha Industries', 0, 23);
  await a.engine.syncNow();
  assert.equal(office.rows.meetings.get(s.id).data.status, 'planned');

  await new Promise((r) => setTimeout(r, 5));
  await a.store.saveMeeting({ ...a.store.meetingById(s.id), id: s.id, status: 'done', meeting_at: new Date().toISOString(), result: 'price_asked', discussion: 'Wants a quote' });
  await a.engine.syncNow();

  const data = office.rows.meetings.get(s.id).data;
  assert.deepEqual([data.status, data.result, data.scheduled_at, data.discussion], ['done', 'price_asked', s.scheduled_at, 'Wants a quote']);
});

test('an office that does not know planned meetings and routes keeps working', async () => {
  office.ignoresPlanning = true;
  const a = await phone();
  const [s1, s2] = await threeStops(a.store);
  const route = await a.store.saveRoute({ title: 'Alwar run', area: 'Alwar', stops_order: [s1.id, s2.id] });
  await a.engine.syncNow();

  // the meetings are stored as ordinary ones; the route has no office to go to, and nothing breaks
  assert.equal(office.count('meetings'), 3);
  assert.equal('status' in office.rows.meetings.get(s1.id).data, false);
  assert.equal(office.count('routes'), 0);
  assert.equal(a.store.refused.length, 0, 'nothing is refused');
  assert.equal(a.store.routeById(route.id).title, 'Alwar run', 'the rep still has the route on the phone');

  // the pull of that office does not wipe what the phone knows
  await a.engine.syncNow();
  assert.equal(a.store.meetingById(s1.id).status, 'planned');
  assert.equal(a.store.meetingById(s1.id).route_id, route.id);
});

test('what the office sends for a route is checked', () => {
  const stopId = crypto.randomUUID();
  const good = { uuid: crypto.randomUUID(), date: '2026-10-28', title: 'Bhiwadi run', area: 'Bhiwadi', start_time: '10:00', overnight: false, stops_order: [stopId], updated_at: new Date().toISOString() };

  assert.equal(cleanRoute(good).title, 'Bhiwadi run');
  assert.equal(cleanRoute({ ...good, date: 'tomorrow' }), null);
  assert.equal(cleanRoute({ ...good, uuid: 'x' }), null);
  assert.equal(cleanRoute({ ...good, stops_order: [] }), null);
  assert.equal(cleanRoute({ ...good, stops_order: ['nope'] }), null);
  assert.equal(cleanRoute({ ...good, updated_at: 'x' }), null);
  assert.equal(cleanRoute({ ...good, start_time: '9am' }).start_time, '09:00');
  assert.equal(cleanRoute({ ...good, title: '' }).title, 'Route');
  assert.equal(cleanRoute({ ...good, stops_order: Array.from({ length: 14 }, () => crypto.randomUUID()) }).stops_order.length, 10);
});

test('the export holds the routes, and an old export (without them) still loads', async () => {
  const { store } = await phone();
  const [a] = await threeStops(store);
  await store.saveRoute({ stops_order: [a.id] });

  const out = store.exportAll();
  assert.equal(out.routes.length, 1);
  assert.equal(out.meetings.length, 3);
  assert.equal(out.meetings[0].status, 'planned');

  // a phone that already holds old meetings opens them with the new defaults
  const persist = new MemoryPersist();
  const first = await Store.open(persist, key);
  await first.saveProfile({ name: 'Rep One', employeeCode: 'REP001' });
  const old = await first.saveMeeting({ client_name: 'Old Co', meeting_at: day(-3).toISOString() });
  const reopened = await Store.open(persist, key);
  assert.equal(reopened.meetingById(old.id).status, 'done');
  assert.equal(reopened.routes.length, 0);
});

test('a route belongs to the phone it was made on: erasing everything removes it too', async () => {
  const { store } = await phone();
  const [a] = await threeStops(store);
  await store.saveRoute({ stops_order: [a.id] });
  await store.wipeEverything();

  assert.equal(store.routes.length, 0);
  assert.equal(store.meetings.length, 0);
});
