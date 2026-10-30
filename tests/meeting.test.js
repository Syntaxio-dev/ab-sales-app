import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  OPEN_STATUSES, PLAN_DAYS, RESULTS, atTime, clashWith, clashes, defaultSlot, groupByRoute, isLogged, isOpen, loggedWindowProblem, meetingsOnDay, minutesUntil, nextStop,
  calendarTime, overdueUnlogged, plannedWindowProblem, routeTitleFor, spaceTimes, statusOf, stopsOf, suggestRoute, suggestRun, timeOf, validStartTime, weekStrip,
} from '../src/core/meeting.js';
import { figuresFor } from '../src/core/report.js';
import { recentClients, lastVisit } from '../src/core/enquiry.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { cleanMeeting } from '../src/sync/merge.js';
import { SELFIE, SPOT } from './helpers/checkin.js';

// Meetings that can be planned: the status, the dates that are allowed, and the pure helpers of the Meetings screens.

let key;
beforeEach(async () => { key = await aesKey(randomBytes(32)); });

async function open() {
  const store = await Store.open(new MemoryPersist(), key);
  await store.saveProfile({ name: 'Rep One', employeeCode: 'REP001' });
  return store;
}

// a local moment: `n` days from today at hh:mm
const day = (n = 0, hh = 10, mm = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hh, mm, 0, 0);
  return d;
};
const iso = (d) => d.toISOString();

const planned = (n, hh = 10, mm = 0, extra = {}) => ({
  client_id: null, client_name: 'JK Cement', meeting_at: iso(day(n, hh, mm)), scheduled_at: iso(day(n, hh, mm)), status: 'planned', ...extra,
});

// a meeting record as the screens read it (no store needed)
const m = (id, n, hh, extra = {}) => ({
  id, client_id: `c-${id}`, client_name: `Client ${id}`, status: 'planned', meeting_at: iso(day(n, hh)), scheduled_at: iso(day(n, hh)), route_id: null, time_manual: false, ...extra,
});

// ---- the status --------------------------------------------------------------------------------------------

test('a meeting without a status is an old one: it counts as done', async () => {
  assert.equal(statusOf({}), 'done');
  assert.equal(statusOf({ status: 'weird' }), 'done');
  assert.equal(isLogged({}), true);
  assert.equal(isOpen({}), false);
  assert.deepEqual(OPEN_STATUSES, ['planned', 'moved']);

  const store = await open();
  const old = await store.saveMeeting({ client_name: 'Old Co', meeting_at: iso(day(-2)) });
  assert.equal(old.status, 'done');
  assert.equal(old.scheduled_at, null);
  assert.equal(old.route_id, null);
  assert.equal(old.result, null);
  assert.equal(old.time_manual, false);
});

test('a meeting stored before the planning fields existed loads with their defaults', async () => {
  const store = await open();
  const cleaned = cleanMeeting({ uuid: crypto.randomUUID(), client_name: 'Old Co', meeting_at: iso(day(-3)), updated_at: iso(day(-3)) });

  assert.equal(cleaned.status, 'done');
  assert.equal(cleaned.route_id, null);
  assert.equal(cleaned.scheduled_at, null);
  await store.putFromServer('meeting', cleaned);
  assert.equal(store.meetingById(cleaned.id).status, 'done');
});

test('what the office sends for the new fields is checked', () => {
  const good = { uuid: crypto.randomUUID(), client_name: 'JK', meeting_at: iso(day(1)), updated_at: iso(day(0)) };
  const route = crypto.randomUUID();

  const full = cleanMeeting({ ...good, status: 'moved', scheduled_at: iso(day(1)), route_uuid: route, result: 'order', moved_from: iso(day(0)), time_manual: true });
  assert.deepEqual([full.status, full.route_id, full.result, full.time_manual], ['moved', route, 'order', true]);

  const bad = cleanMeeting({ ...good, status: 'archived', route_uuid: 'nope', result: 'maybe', scheduled_at: 'x', time_manual: 'yes' });
  assert.deepEqual([bad.status, bad.route_id, bad.result, bad.scheduled_at, bad.time_manual], ['done', null, null, null, false]);
});

// ---- the dates that are allowed ----------------------------------------------------------------------------

test('a planned meeting: today up to 90 days ahead, never on a day that has passed', async () => {
  const store = await open();

  assert.ok(await store.saveMeeting(planned(0, 23, 0)), 'today');
  assert.ok(await store.saveMeeting(planned(1)));
  assert.ok(await store.saveMeeting(planned(PLAN_DAYS)), 'the 90th day');

  await assert.rejects(store.saveMeeting(planned(PLAN_DAYS + 1)), /90 days/);
  await assert.rejects(store.saveMeeting(planned(-1)), ValidationError);
  await assert.rejects(store.saveMeeting(planned(-30)), /passed/);
  assert.equal(store.meetings.length, 3);
});

test('a planned meeting keeps one time: meeting_at follows the plan', async () => {
  const store = await open();
  const saved = await store.saveMeeting({ ...planned(2, 15, 0), meeting_at: iso(day(5)) });

  assert.equal(saved.meeting_at, saved.scheduled_at);
  assert.equal(saved.scheduled_at, iso(day(2, 15, 0)));
});

test('a meeting that happened may still be written up to a day ahead, not more', async () => {
  const store = await open();

  assert.ok(await store.saveMeeting({ client_name: 'A', meeting_at: iso(day(-1)), status: 'done', ...SPOT }, SELFIE));
  assert.ok(await store.saveMeeting({ client_name: 'B', meeting_at: new Date(Date.now() + 3_600_000).toISOString() }), 'an hour ahead (clocks differ)');
  await assert.rejects(store.saveMeeting({ client_name: 'C', meeting_at: iso(day(3)) }), /after tomorrow/);
  await assert.rejects(store.saveMeeting({ client_name: 'D', meeting_at: iso(day(3)), status: 'done' }), ValidationError);
});

test('an overdue planned meeting can be edited without picking a new time, and an old one cannot be moved into the past', async () => {
  const store = await open();
  // a visit that was planned for yesterday (as it is after a night passes): put it on the phone the way a sync would
  const old = { ...cleanMeeting({ uuid: crypto.randomUUID(), client_name: 'Late Co', meeting_at: iso(day(-1)), scheduled_at: iso(day(-1)), status: 'planned', updated_at: iso(day(-2)) }) };
  await store.putFromServer('meeting', old);

  const edited = await store.saveMeeting({ ...store.meetingById(old.id), id: old.id, discussion: 'Called to say sorry' });
  assert.equal(edited.status, 'planned');
  assert.equal(edited.discussion, 'Called to say sorry');

  await assert.rejects(store.saveMeeting({ ...planned(-3), id: old.id }), /passed/);
  assert.equal((await store.saveMeeting({ ...planned(4), id: old.id, status: 'moved', moved_from: old.scheduled_at })).status, 'moved');
});

test('the result and the status are checked; a result only belongs to a visit that was done', async () => {
  const store = await open();

  for (const r of RESULTS) assert.equal((await store.saveMeeting({ client_name: 'A', meeting_at: iso(day(-1)), status: 'done', result: r.value, ...SPOT }, SELFIE)).result, r.value);
  await assert.rejects(store.saveMeeting({ client_name: 'A', meeting_at: iso(day(-1)), status: 'done', result: 'maybe', ...SPOT }, SELFIE), ValidationError);
  await assert.rejects(store.saveMeeting({ client_name: 'A', meeting_at: iso(day(-1)), status: 'archived' }), ValidationError);

  const missed = await store.saveMeeting({ client_name: 'A', meeting_at: iso(day(-1)), status: 'missed', result: 'order' });
  assert.equal(missed.result, null);
  const open1 = await store.saveMeeting({ ...planned(1), result: 'order' });
  assert.equal(open1.result, null);
});

test('only logged meetings count in the daily report, and a planned visit is not a visit that happened', async () => {
  const store = await open();
  const client = await store.saveClient({ lat: 26.9124, lng: 75.7873, name: 'JK Cement', phone: '98765 43210' });
  await store.saveMeeting({ client_id: client.id, client_name: 'JK Cement', meeting_at: new Date().toISOString(), status: 'done', ...SPOT }, SELFIE);
  await store.saveMeeting({ client_id: client.id, client_name: 'JK Cement', ...planned(0, 23, 59), status: 'planned' });

  const today = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
  assert.equal(figuresFor(store, today).meetings, 1);

  const enquiries = [];
  const logged = [{ client_id: client.id, meeting_at: iso(day(-2)), status: 'planned' }, { client_id: client.id, meeting_at: iso(day(-5)) }];
  assert.equal(lastVisit(logged, client.id).getTime(), day(-5).getTime(), 'a planned or missed meeting is no visit');
  assert.equal(recentClients({ enquiries, meetings: logged.slice(0, 1), clients: [client] }).length, 0);
});

// ---- the helpers -------------------------------------------------------------------------------------------

test('timeOf: the plan for a meeting that has not happened, the real time for one that was logged', () => {
  const real = m('a', 0, 11, { status: 'done', meeting_at: iso(day(0, 11, 20)), scheduled_at: iso(day(0, 11, 0)) });
  assert.equal(timeOf(real).getTime(), day(0, 11, 20).getTime());
  assert.equal(timeOf(m('b', 0, 9, { meeting_at: iso(day(0, 8)) })).getTime(), day(0, 9).getTime());
  assert.equal(timeOf({ meeting_at: iso(day(0, 8)) }).getTime(), day(0, 8).getTime(), 'an old meeting');
  assert.equal(timeOf(m('c', 0, 9, { status: 'missed' })).getTime(), day(0, 9).getTime());
});

test('meetingsOnDay: one calendar day, earliest first', () => {
  const list = [m('late', 0, 16), m('other', 1, 9), m('early', 0, 8), m('mid', 0, 12, { status: 'done', meeting_at: iso(day(0, 12)), scheduled_at: null })];

  assert.deepEqual(meetingsOnDay(list, day(0, 3)).map((x) => x.id), ['early', 'mid', 'late']);
  assert.deepEqual(meetingsOnDay(list, day(2)), []);
});

test('weekStrip: Monday to Sunday with the number of meetings of each day', () => {
  const wednesday = new Date(2026, 9, 28, 15, 0); // Wed 28 Oct 2026
  const list = [
    { id: '1', meeting_at: new Date(2026, 9, 26, 10).toISOString() },
    { id: '2', meeting_at: new Date(2026, 9, 28, 9).toISOString() },
    { id: '3', meeting_at: new Date(2026, 9, 28, 14).toISOString() },
    { id: '4', meeting_at: new Date(2026, 10, 1, 10).toISOString() },
    { id: '5', meeting_at: new Date(2026, 10, 2, 10).toISOString() }, // next week
  ];
  const week = weekStrip(wednesday, list, wednesday);

  assert.equal(week.length, 7);
  assert.deepEqual(week.map((d) => d.num), [26, 27, 28, 29, 30, 31, 1]);
  assert.deepEqual(week.map((d) => d.letter).join(''), 'MTWTFSS');
  assert.deepEqual(week.map((d) => d.count), [1, 0, 2, 0, 0, 0, 1]);
  assert.deepEqual(week.map((d) => d.today), [false, false, true, false, false, false, false]);
  assert.equal(weekStrip(new Date(2026, 9, 25), [], wednesday)[0].num, 19, 'a Sunday belongs to the week before it');
});

test('groupByRoute: route cards and single meetings, by start time; a stop of an unknown route is shown alone', () => {
  const route = { id: 'r1', date: 'x', title: 'Bhiwadi run', area: 'Bhiwadi', stops_order: ['b', 'a'] };
  const list = [m('a', 0, 11, { route_id: 'r1' }), m('b', 0, 14, { route_id: 'r1', status: 'done', meeting_at: iso(day(0, 14)) }), m('solo', 0, 9), m('ghost', 0, 10, { route_id: 'gone' })];
  const items = groupByRoute(meetingsOnDay(list, day(0)), [route]);

  assert.deepEqual(items.map((i) => i.type), ['single', 'single', 'route']);
  assert.deepEqual(items.map((i) => i.type === 'route' ? i.route.id : i.meeting.id), ['solo', 'ghost', 'r1']);
  const card = items[2];
  assert.deepEqual(card.stops.map((s) => s.id), ['b', 'a'], "in the route's own order");
  assert.equal(card.done, 1);
  assert.equal(card.start.getTime(), day(0, 11).getTime());
  assert.equal(card.end.getTime(), day(0, 14).getTime());
});

test('stopsOf puts a stop that is missing from the order last; nextStop is the first one still to happen', () => {
  const route = { id: 'r', stops_order: ['a'] };
  const list = [m('a', 0, 9, { route_id: 'r', status: 'done', meeting_at: iso(day(0, 9)) }), m('z', 0, 15, { route_id: 'r' }), m('y', 0, 12, { route_id: 'r' }), m('x', 0, 8)];
  const stops = stopsOf(route, list);

  assert.deepEqual(stops.map((s) => s.id), ['a', 'y', 'z']);
  assert.equal(nextStop(stops).id, 'y');
  assert.equal(nextStop(stops.slice(0, 1)), null);
  assert.equal(nextStop([]), null);
});

test('minutesUntil', () => {
  const now = day(0, 10, 0);
  assert.equal(minutesUntil(m('a', 0, 10, { scheduled_at: iso(day(0, 10, 40)) }), now), 40);
  assert.equal(minutesUntil(m('a', 0, 9, { scheduled_at: iso(day(0, 9, 30)) }), now), -30);
});

test('suggestRoute: a route of that day in the same place with room; suggestRun: another meeting of the day in the same place', () => {
  const key = (n) => { const d = day(n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const routes = [
    { id: 'r1', date: key(0), area: 'Bhiwadi', stops_order: ['a'] },
    { id: 'r2', date: key(1), area: 'Alwar', stops_order: ['b'] },
    { id: 'full', date: key(0), area: 'Kota', stops_order: Array.from({ length: 10 }, (_, i) => `s${i}`) },
  ];

  assert.equal(suggestRoute('bhiwadi ', day(0, 15), routes).id, 'r1', 'same place, any spelling of capitals');
  assert.equal(suggestRoute('Bhiwadi', day(1), routes), null, 'another day');
  assert.equal(suggestRoute('Kota', day(0), routes), null, 'no room left');
  assert.equal(suggestRoute('', day(0), routes), null);

  const cities = { a: 'Bhiwadi', b: 'Bhiwadi', c: 'Alwar', d: 'Bhiwadi' };
  const list = [m('a', 0, 10), m('b', 0, 12, { route_id: 'r9' }), m('c', 0, 11), m('d', 1, 10), m('e', 0, 9, { status: 'done', meeting_at: iso(day(0, 9)) })];
  const cityOf = (x) => cities[x.id] ?? '';

  assert.equal(suggestRun('Bhiwadi', day(0), list, cityOf).id, 'a');
  assert.equal(suggestRun('Bhiwadi', day(0), list, cityOf, 'a'), null, 'not the meeting being edited, and one already in a route is not offered');
  assert.equal(suggestRun('Alwar', day(0), list, cityOf).id, 'c');
  assert.equal(suggestRun('Jaipur', day(0), list, cityOf), null);
  assert.equal(routeTitleFor('Bhiwadi'), 'Bhiwadi run');
  assert.equal(routeTitleFor('  '), 'Route');
});

test('spaceTimes: from the start time, 90 minutes apart; logged stops and times set by hand stay', () => {
  const stops = [m('a', 0, 10), m('b', 0, 10), m('c', 0, 10), m('d', 0, 10)];
  const hhmm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  assert.deepEqual(spaceTimes(stops, '09:00').map(hhmm), ['9:00', '10:30', '12:00', '13:30']);
  assert.deepEqual(spaceTimes(stops, '09:00', 60).map(hhmm), ['9:00', '10:00', '11:00', '12:00']);

  const mixed = [
    m('a', 0, 9, { status: 'done', meeting_at: iso(day(0, 9, 20)) }),
    m('b', 0, 10),
    m('c', 0, 16, { time_manual: true }),
    m('d', 0, 10),
  ];
  assert.deepEqual(spaceTimes(mixed, '09:00').map(hhmm), ['9:20', '10:50', '16:00', '17:30'], 'a done stop and a hand-set time are never overwritten');
  assert.deepEqual(spaceTimes([], '09:00'), []);
  assert.equal(validStartTime('09:30'), true);
  assert.equal(validStartTime('9:30'), false);
  assert.equal(validStartTime('24:00'), false);
});

test('overdueUnlogged: planned meetings whose time passed with no result, newest first', () => {
  const now = day(0, 15, 0);
  const list = [
    m('old', -1, 10), m('today', 0, 11), m('later', 0, 17), m('done', -1, 9, { status: 'done', meeting_at: iso(day(-1, 9)) }),
    m('missed', -2, 9, { status: 'missed' }), m('moved', 0, 12, { status: 'moved' }),
  ];

  assert.deepEqual(overdueUnlogged(list, now).map((x) => x.id), ['moved', 'today', 'old']);
  assert.deepEqual(overdueUnlogged(list, now, 240).map((x) => x.id), ['old'], 'with an allowance: a meeting that started an hour ago is not yet overdue');
  assert.deepEqual(overdueUnlogged([], now), []);
});

test('clashes: two meetings that overlap in time; a missed one does not count', () => {
  const list = [m('a', 0, 10), m('b', 0, 10, {}), m('c', 0, 11), m('d', 0, 12, { scheduled_at: iso(day(0, 12, 30)) }), m('e', 0, 12, { status: 'missed' })];
  list[1].scheduled_at = iso(day(0, 10, 30));

  const pairs = clashes(list).map(([x, y]) => `${x.id}${y.id}`);
  assert.deepEqual(pairs, ['ab', 'bc'], 'b runs 10:30 to 11:30 and c starts at 11:00; a ends at 11:00, so a and c do not clash; the missed one never does');
  assert.deepEqual(clashes([m('x', 0, 9), m('y', 0, 11)]), []);

  const withEnd = [m('p', 0, 9, { ended_at: iso(day(0, 11, 30)) }), m('q', 0, 11)];
  assert.equal(clashes(withEnd).length, 1, 'a known end time is used');

  assert.equal(clashWith(list, day(0, 10, 45), 'zzz').id, 'a');
  assert.equal(clashWith([m('a', 0, 10)], day(0, 14)), null);
  assert.equal(clashWith([m('a', 0, 10)], day(0, 10, 30), 'a'), null, 'not against itself');
});

test('the planned window and the logged window', () => {
  const now = day(0, 12);

  assert.equal(plannedWindowProblem(day(0, 8), now), null, 'earlier today is fine');
  assert.equal(plannedWindowProblem(day(90, 10), now), null);
  assert.match(plannedWindowProblem(day(91, 10), now), /90 days/);
  assert.match(plannedWindowProblem(day(-1, 23), now), /passed/);
  assert.equal(plannedWindowProblem(new Date('nope'), now), 'Pick the date and time.');

  assert.equal(loggedWindowProblem(day(-40), now), null);
  assert.equal(loggedWindowProblem(day(1, 8), now), null);
  assert.match(loggedWindowProblem(day(2), now), /tomorrow/);
});

test('defaultSlot: the next full hour at least 30 minutes away, else tomorrow 10 am', () => {
  const at = (hh, mm) => new Date(2026, 9, 28, hh, mm);
  const text = (d) => `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  assert.equal(text(defaultSlot(at(10, 10))), '28 11:00');
  assert.equal(text(defaultSlot(at(10, 40))), '28 12:00', 'less than 30 minutes to 11:00');
  assert.equal(text(defaultSlot(at(10, 30))), '28 11:00');
  assert.equal(text(defaultSlot(at(6, 0))), '28 9:00', 'not before 9 am');
  assert.equal(text(defaultSlot(at(18, 45))), '29 10:00', 'too late today');
  assert.equal(text(defaultSlot(at(23, 50))), '29 10:00');
  assert.equal(atTime(at(5, 5), '14:30').getHours(), 14);
});

test('a stop of a route written up early stays on its planned day; a meeting on its own is where it happened', () => {
  const planned = day(1, 10);
  const stop = m('s', 1, 10, { route_id: 'r1', status: 'done', meeting_at: iso(day(0, 15)), scheduled_at: iso(planned) });
  const alone = m('a', 1, 11, { status: 'done', meeting_at: iso(day(0, 16)), scheduled_at: iso(day(1, 11)) });
  const list = [stop, alone];

  assert.deepEqual(meetingsOnDay(list, day(1)).map((x) => x.id), ['s'], 'with its route, tomorrow');
  assert.deepEqual(meetingsOnDay(list, day(0)).map((x) => x.id), ['a'], 'on its own, today');
  assert.equal(timeOf(stop).getTime(), day(0, 15).getTime(), 'the time it happened is still known');
  assert.equal(weekStrip(day(0), list).reduce((n, d) => n + d.count, 0), 2);
});
