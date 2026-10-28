// Meetings and routes: what a meeting is (planned, done, missed, moved), which ones belong together on one trip, and the small
// calculations the Meetings screens need. Pure functions only (no screen, no store), so they are tested on their own.
//
// A meeting keeps ONE time in `meeting_at` (as always: sorting, reports and the office use it). For a planned meeting it is the planned
// time; `scheduled_at` keeps the plan when the visit is logged (then `meeting_at` is when it really happened).

export const STATUSES = ['planned', 'done', 'missed', 'moved'];
export const OPEN_STATUSES = ['planned', 'moved']; // still to happen
export const RESULTS = [
  { value: 'price_asked', label: 'Price asked' },
  { value: 'demo_booked', label: 'Demo booked' },
  { value: 'order', label: 'Order' },
  { value: 'not_interested', label: 'Not interested' },
];
export const PURPOSES = ['Price talk', 'Demo', 'Payment', 'Service'];

export const PLAN_DAYS = 90;          // a meeting can be planned this many days ahead
export const MAX_STOPS = 10;          // stops in one route
export const CLASH_MINUTES = 60;      // how long a meeting is assumed to last when no end time is known
export const BASE_CITY = 'Jaipur';  // the rep's base: a trip to another place asks about the travel expense
export const ROUTE_MINUTES = 90;      // the default time between two stops of a route

const MINUTE = 60_000;
const DAY = 86_400_000;

// A meeting without a status is an old one: it was written after it happened.
export const statusOf = (m) => (STATUSES.includes(m?.status) ? m.status : 'done');
export const isOpen = (m) => OPEN_STATUSES.includes(statusOf(m));
export const isLogged = (m) => statusOf(m) === 'done';
export const resultLabel = (value) => RESULTS.find((r) => r.value === value)?.label ?? '';

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
export const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n, date.getHours(), date.getMinutes());

// "10:30" + a day -> that moment on that day (local time)
export function atTime(date, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h || 0, m || 0);
}

export const timeText = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
export const validStartTime = (text) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(text ?? ''));

// When the meeting is (or was): the plan for one that has not happened, the real time for one that was logged.
export function timeOf(m) {
  const planned = isOpen(m) || statusOf(m) === 'missed';
  return new Date(planned ? (m.scheduled_at ?? m.meeting_at) : m.meeting_at);
}

// Where a meeting stands in the agenda: when it happened, except a stop of a route, which stays with its route (on the day it was
// planned) even when the visit was written up early or late.
export const calendarTime = (m) => (m.route_id && m.scheduled_at ? new Date(m.scheduled_at) : timeOf(m));

// The meetings of one calendar day, earliest first.
export function meetingsOnDay(meetings, date) {
  const key = dayKey(date);
  return meetings
    .filter((m) => dayKey(calendarTime(m)) === key)
    .sort((a, b) => calendarTime(a) - calendarTime(b) || String(a.id).localeCompare(String(b.id)));
}

// Monday to Sunday of the week that holds `date`: [{ date, key, letter, num, count, today }]
export function weekStrip(date, meetings = [], now = new Date()) {
  const monday = startOfDay(date);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const counts = new Map();
  for (const m of meetings) {
    const key = dayKey(calendarTime(m));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return letters.map((letter, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const key = dayKey(d);
    return { date: d, key, letter, num: d.getDate(), count: counts.get(key) ?? 0, today: key === dayKey(now) };
  });
}

// The stops of a route in the route's own order. A meeting that points at the route but is missing from the order comes last (by time).
export function stopsOf(route, meetings) {
  const mine = meetings.filter((m) => m.route_id === route.id);
  const byId = new Map(mine.map((m) => [m.id, m]));
  const ordered = (route.stops_order ?? []).map((id) => byId.get(id)).filter(Boolean);
  const rest = mine.filter((m) => !(route.stops_order ?? []).includes(m.id)).sort((a, b) => timeOf(a) - timeOf(b));
  return [...ordered, ...rest];
}

/**
 * One day as it is drawn: route cards and single meetings, by start time.
 *   { type: 'route', route, stops, start, end, done }   stops in route order, done = how many are logged
 *   { type: 'single', meeting, start }
 * A meeting whose route is not known (not synced yet) is shown as a single one.
 */
export function groupByRoute(dayMeetings, routes = []) {
  const known = new Map(routes.map((r) => [r.id, r]));
  const used = new Set();
  const items = [];

  for (const route of routes) {
    const stops = stopsOf(route, dayMeetings);
    if (!stops.length) continue;
    stops.forEach((s) => used.add(s.id));

    const times = stops.map((s) => calendarTime(s));
    items.push({ type: 'route', route, stops, start: new Date(Math.min(...times)), end: new Date(Math.max(...times)), done: stops.filter((s) => statusOf(s) !== 'planned' && statusOf(s) !== 'moved').length });
  }

  for (const m of dayMeetings) {
    if (used.has(m.id) && known.has(m.route_id)) continue;
    items.push({ type: 'single', meeting: m, start: calendarTime(m) });
  }

  return items.sort((a, b) => a.start - b.start);
}

// The stop the rep goes to next: the first one still to happen, in route order.
export const nextStop = (stops) => stops.find((s) => isOpen(s)) ?? null;

// Whole minutes from `now` until the meeting (negative = already past)
export const minutesUntil = (m, now = new Date()) => Math.round((timeOf(m) - now) / MINUTE);

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase() && String(a ?? '').trim() !== '';

// A route of that day in the same place that still has room: the one to offer when a meeting is added in that place.
export function suggestRoute(clientCity, date, routes) {
  const key = dayKey(date);
  return routes.find((r) => r.date === key && same(r.area, clientCity) && (r.stops_order?.length ?? 0) < MAX_STOPS) ?? null;
}

// No route yet, but another meeting of the day (not in a route) is in the same place: the meeting a new run could be made with.
// `cityOf(meeting)` gives the place of the meeting's client.
export function suggestRun(clientCity, date, meetings, cityOf, exceptId = null) {
  const key = dayKey(date);
  return meetings.find((m) => m.id !== exceptId && isOpen(m) && !m.route_id && dayKey(timeOf(m)) === key && same(cityOf(m), clientCity)) ?? null;
}

export const routeTitleFor = (area) => (String(area ?? '').trim() ? `${String(area).trim()} run` : 'Route');

/**
 * The times of a route's stops, in order. The first stop starts at `startTime` ("HH:MM") and every next one `defaultMinutes` after the one
 * before, except: a stop already logged (done or missed) and a stop whose time the rep set by hand (`time_manual`) keep their own time.
 * Returns one Date per stop, on the day of the first stop.
 */
export function spaceTimes(stops, startTime, defaultMinutes = ROUTE_MINUTES) {
  if (!stops.length) return [];

  const day = timeOf(stops[0]);
  const times = [];
  let previous = null;

  stops.forEach((stop, i) => {
    const keep = !isOpen(stop) || stop.time_manual === true;
    let at;

    if (keep) at = timeOf(stop);
    else if (i === 0 || previous === null) at = atTime(day, startTime);
    else at = new Date(previous.getTime() + defaultMinutes * MINUTE);

    times.push(at);
    previous = at;
  });

  return times;
}

// Planned meetings whose time has passed (plus `graceMinutes`) with no result written. The newest first.
export function overdueUnlogged(meetings, now = new Date(), graceMinutes = 0) {
  return meetings
    .filter((m) => isOpen(m) && timeOf(m).getTime() + graceMinutes * MINUTE < now.getTime())
    .sort((a, b) => timeOf(b) - timeOf(a));
}

export function endOf(m, minutes = CLASH_MINUTES) {
  const end = m.ended_at ? new Date(m.ended_at) : null;
  return end && !Number.isNaN(end.getTime()) && end > timeOf(m) ? end : new Date(timeOf(m).getTime() + minutes * MINUTE);
}

// Pairs of meetings that overlap in time (a missed one does not count). The same rep: the phone only ever holds one rep's meetings.
export function clashes(meetings, minutes = CLASH_MINUTES) {
  const list = meetings.filter((m) => statusOf(m) !== 'missed').sort((a, b) => timeOf(a) - timeOf(b));
  const pairs = [];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (timeOf(list[j]) >= endOf(list[i], minutes)) break;
      pairs.push([list[i], list[j]]);
    }
  }
  return pairs;
}

// The meeting (if any) that overlaps the proposed time, other than `exceptId`.
export function clashWith(meetings, at, exceptId = null, minutes = CLASH_MINUTES) {
  const end = new Date(at.getTime() + minutes * MINUTE);
  return meetings.find((m) => m.id !== exceptId && isOpen(m) && timeOf(m) < end && endOf(m, minutes) > at) ?? null;
}

// The rule for a planned time: today up to 90 days ahead, never an earlier day. Returns the message, or null when fine.
export function plannedWindowProblem(at, now = new Date()) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return 'Pick the date and time.';
  if (startOfDay(at) < startOfDay(now)) return 'A planned meeting cannot be on a day that has passed.';
  if (at.getTime() >= startOfDay(now).getTime() + (PLAN_DAYS + 1) * DAY) return `Plan at most ${PLAN_DAYS} days ahead.`;
  return null;
}

// A meeting that already happened may be written up to a day ahead (clocks differ), not more.
export function loggedWindowProblem(at, now = new Date()) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return 'Pick the date and time.';
  return at.getTime() > now.getTime() + DAY + MINUTE ? 'A meeting that happened cannot be after tomorrow.' : null;
}

// The time a new meeting starts on: the next full hour at least 30 minutes away (not before 9 am); after 7 pm: tomorrow 10 am.
export function defaultSlot(now = new Date()) {
  const next = new Date(now.getTime() + 30 * MINUTE);
  if (next.getMinutes() > 0 || next.getSeconds() > 0) next.setHours(next.getHours() + 1, 0, 0, 0);
  else next.setMinutes(0, 0, 0);

  if (next.getDate() !== now.getDate() || next.getHours() > 19) return atTime(addDays(startOfDay(now), 1), '10:00');
  if (next.getHours() < 9) next.setHours(9, 0, 0, 0);
  return next;
}
