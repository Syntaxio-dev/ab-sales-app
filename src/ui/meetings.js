import {
  addDays, calendarTime, dayKey, groupByRoute, isOpen, meetingsOnDay, minutesUntil, nextStop, overdueUnlogged, resultLabel, spaceTimes, startOfDay, statusOf, timeOf, weekStrip,
} from '../core/meeting.js';
import * as rules from '../core/rules.js';
import { h, icon } from './dom.js';
import { formatDay, formatHeadDay, formatTime, initials } from './format.js';
import { businessInput } from './inputs.js';
import { confirmDialog, dialog, field, openBottomSheet, openPage, toast } from './kit.js';
import { openSchedule } from './meeting-schedule.js';
import { openVisit } from './meeting-visit.js';
import { timeInput } from './pickers.js';
import { empty, fill, head } from './parts.js';
import { shortDay } from './when-chips.js';

// The Meetings tab: a week strip, the chosen day as route cards and single meetings, a reminder for visits nobody wrote up, and the
// route menu (rename, reorder, start time, delete). Everything shown is the signed-in rep's own (the phone holds nobody else's).

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const OVERDUE_GRACE = 60; // minutes: a meeting is only "not logged" an hour after it started

let selected = null; // the day shown (a Date at midnight); null = today
let upcoming = false; // the simple list of the next 30 days instead of one day

export function resetMeetingView() {
  selected = null;
  upcoming = false;
}

const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// "Today", "Tomorrow", "Yesterday" or the date
function dayName(date, now = new Date()) {
  const diff = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : shortDay(date);
}

// "In 40 min" for the stop or meeting that is next (coral when under an hour), only on the day itself
function whenTag(m, now) {
  if (!isOpen(m) || dayKey(timeOf(m)) !== dayKey(now)) return null;

  const mins = minutesUntil(m, now);
  if (mins <= 0) return mins > -OVERDUE_GRACE ? h('span', { class: 'chip late' }, 'Now') : null;
  if (mins < 60) return h('span', { class: 'chip late' }, `In ${mins} min`);
  return h('span', { class: 'chip today' }, `In ${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`);
}

const cityOf = (app, m) => app.store.clientById(m.client_id)?.city ?? '';

function statusTag(m) {
  const s = statusOf(m);
  if (s === 'done') return h('span', { class: 'chip approved' }, m.result ? resultLabel(m.result) : 'Done');
  if (s === 'missed') return h('span', { class: 'chip late' }, 'Missed');
  if (s === 'moved') return h('span', { class: 'chip' }, 'Moved');
  return null;
}

// ---- cards ------------------------------------------------------------------------------------------------------------

function singleCard(app, m, now) {
  const sub = [cityOf(app, m), m.purpose].filter(Boolean).join(' · ');

  return h('button', { class: 'item meet', onclick: () => openVisit(app, m.id) },
    h('span', { class: 'avatar' }, initials(m.client_name)),
    h('span', { class: 'grow' },
      h('span', { class: 'mtime' }, formatTime(timeOf(m))),
      h('span', { class: 'title' }, m.client_name),
      sub ? h('span', { class: 'sub' }, sub) : null),
    h('span', { class: 'end' }, statusTag(m), whenTag(m, now)));
}

// A row of the Home "follow-ups" list and of a client's meetings: what it was, when, and the follow-up date.
export function meetingRow(app, m) {
  const follow = m.next_followup_at ? new Date(m.next_followup_at) : null;
  const late = follow && follow.getTime() < Date.now();

  return h('button', { class: 'item', onclick: () => openVisit(app, m.id) },
    h('span', { class: 'avatar' }, initials(m.client_name)),
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, m.client_name),
      h('span', { class: 'sub' }, `${dayName(timeOf(m))}, ${formatTime(timeOf(m))}${m.purpose ? ` · ${m.purpose}` : ''}`)),
    follow ? h('span', { class: 'end' }, h('span', { class: `chip${late ? ' late' : ''}` }, icon('alarm', 12), formatDay(follow))) : statusTag(m) ? h('span', { class: 'end' }, statusTag(m)) : null);
}

function routeCard(app, item, now) {
  const { route, stops } = item;
  const next = nextStop(stops);
  const finished = (s) => !isOpen(s);
  const lastFinished = stops.reduce((last, s, i) => (finished(s) ? i : last), -1);
  const span = `${formatTime(item.start)}${stops.length > 1 ? ` to ${formatTime(item.end)}` : ''}`;

  const line = stops.map((stop, i) => {
    const state = statusOf(stop) === 'done' ? 'done' : statusOf(stop) === 'missed' ? 'missed' : stop === next ? 'next' : 'later';
    const sub = [stop.purpose, cityOf(app, stop)].filter(Boolean).join(' · ');

    return h('li', { class: `stop ${state}${i < lastFinished ? ' lit' : ''}` },
      h('button', { type: 'button', class: 'stop-btn', onclick: () => openVisit(app, stop.id) },
        h('span', { class: 'stop-mark', 'aria-hidden': 'true' }, state === 'done' ? icon('check', 13) : state === 'missed' ? icon('close', 12) : state === 'next' ? h('i') : null),
        h('span', { class: 'grow' },
          h('span', { class: 'mtime' }, formatTime(timeOf(stop))),
          h('span', { class: 'title' }, stop.client_name),
          sub ? h('span', { class: 'sub' }, sub) : null,
          h('span', { class: 'sr-only' }, state === 'done' ? 'Done' : state === 'missed' ? 'Missed' : state === 'next' ? 'Next stop' : 'Later')),
        stop === next ? whenTag(stop, now) : null));
  });

  return h('div', { class: 'card pad route-card' },
    h('div', { class: 'route-head' },
      h('span', { class: 'tile-icon' }, icon('route', 20)),
      h('div', { class: 'grow' },
        h('div', { class: 'route-line' }, h('h2', { class: 'route-title' }, route.title), h('span', { class: `chip ${item.done === stops.length ? 'approved' : ''}` }, `${item.done} of ${stops.length} done`)),
        h('p', { class: 'muted small' }, `${stops.length} stop${stops.length === 1 ? '' : 's'} · ${span}`)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Options for ${route.title}`, onclick: () => openRouteMenu(app, route.id) }, icon('more', 20))),
    h('ol', { class: 'timeline' }, line));
}

// ---- the tab ----------------------------------------------------------------------------------------------------------

export function renderMeetings(container, app, ctx) {
  const store = app.store;
  const now = new Date();
  const meetings = store.meetings;
  const routes = store.routes;
  selected ??= startOfDay(now);

  const redraw = () => renderMeetings(container, app, ctx);
  const go = (date) => {
    selected = startOfDay(date);
    upcoming = false;
    redraw();
  };
  const isToday = dayKey(selected) === dayKey(now);

  // ---- the reminder for visits nobody wrote up
  const overdue = overdueUnlogged(meetings, now, OVERDUE_GRACE);
  const strip = overdue.length ? (() => {
    const m = overdue[0];
    const rest = overdue.length - 1;
    return h('div', { class: 'enq-warn overdue-strip', role: 'status' },
      icon('alert', 18),
      h('p', { class: 'grow' }, `Not logged: ${m.client_name}, ${['Today', 'Yesterday'].includes(dayName(timeOf(m), now)) ? dayName(timeOf(m), now).toLowerCase() : shortDay(timeOf(m))} ${formatTime(timeOf(m))}${rest ? ` · +${rest} more` : ''}`),
      h('button', { type: 'button', class: 'link', onclick: () => openVisit(app, m.id) }, 'Log it'));
  })() : null;

  // ---- the week
  const days = weekStrip(selected, meetings, now);
  let held = false;
  let touchX = null;
  const tiles = h('div', { class: 'week-days', role: 'group', 'aria-label': 'Days of the week' }, days.map((d) => {
    let timer = 0;
    return h('button', {
      type: 'button', class: `day-tile${d.today ? ' today' : ''}`, 'aria-pressed': String(d.key === dayKey(selected)),
      'aria-label': `${WEEKDAYS[d.date.getDay()]} ${d.num}, ${d.count} meeting${d.count === 1 ? '' : 's'}`,
      onpointerdown() { held = false; timer = setTimeout(() => { held = true; go(new Date()); }, 600); }, // a long press jumps back to today
      onpointerup() { clearTimeout(timer); },
      onpointerleave() { clearTimeout(timer); },
      onclick() { if (!held) go(d.date); },
    },
    h('span', { class: 'dl' }, d.letter),
    h('span', { class: 'dn' }, String(d.num)),
    h('span', { class: 'dots', 'aria-hidden': 'true' }, Array.from({ length: Math.min(3, d.count) }, () => h('i'))));
  }));
  tiles.addEventListener('touchstart', (event) => { touchX = event.touches[0].clientX; }, { passive: true });
  tiles.addEventListener('touchend', (event) => {
    if (touchX === null) return;
    const dx = event.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) go(addDays(selected, dx < 0 ? 7 : -7));
  }, { passive: true });

  const monthLabel = `${MONTHS[days[0].date.getMonth()].slice(0, 3)}${days[0].date.getMonth() !== days[6].date.getMonth() ? ` / ${MONTHS[days[6].date.getMonth()].slice(0, 3)}` : ''} ${days[6].date.getFullYear()}`;
  const week = h('div', { class: 'week noswipe' },
    h('div', { class: 'week-nav' },
      h('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Previous week', onclick: () => go(addDays(selected, -7)) }, icon('back', 18)),
      h('span', { class: 'week-month' }, monthLabel),
      isToday ? null : h('button', { type: 'button', class: 'link', onclick: () => go(new Date()) }, 'Today'),
      h('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Next week', onclick: () => go(addDays(selected, 7)) }, icon('chevron', 18))),
    tiles);

  // ---- the day, or the next 30 days
  const body = [];

  if (upcoming) {
    let any = false;
    for (let i = 0; i < 30; i++) {
      const day = addDays(startOfDay(now), i);
      const items = groupByRoute(meetingsOnDay(meetings, day), routes.filter((r) => r.date === dayKey(day)));
      if (!items.length) continue;
      any = true;
      body.push(h('p', { class: 'day-label' }, `${dayName(day, now)}${i > 1 ? '' : ` · ${shortDay(day)}`}`),
        h('div', { class: 'list' }, items.map((it) => (it.type === 'route' ? routeCard(app, it, now) : singleCard(app, it.meeting, now)))));
    }
    if (!any) body.push(empty('calendar', 'Nothing planned', 'Meetings you schedule for the next 30 days show here.'));
    body.push(h('button', { type: 'button', class: 'link left', onclick: () => { upcoming = false; redraw(); } }, 'Back to the week'));
  } else {
    const items = groupByRoute(meetingsOnDay(meetings, selected), routes.filter((r) => r.date === dayKey(selected)));
    const count = items.reduce((n, it) => n + (it.type === 'route' ? it.stops.length : 1), 0);
    const past = startOfDay(selected) < startOfDay(now);

    body.push(h('p', { class: 'eyebrow' }, `${isToday ? 'Today' : WEEKDAYS[selected.getDay()]} · ${count} ${count === 1 ? 'meeting' : 'meetings'}`));

    if (items.length) {
      body.push(h('div', { class: 'list' }, items.map((it) => (it.type === 'route' ? routeCard(app, it, now) : singleCard(app, it.meeting, now)))));
    } else {
      body.push(h('div', { class: 'card pad stack meet-empty' },
        h('p', { class: 'muted' }, past ? 'Nothing logged' : `No meetings on ${isToday ? 'today' : WEEKDAYS[selected.getDay()]}`),
        past ? null : h('button', { type: 'button', class: 'btn small-btn', onclick: () => openSchedule(app, { day: selected }) }, icon('plus', 18), 'Schedule one')));
    }
    body.push(h('button', { type: 'button', class: 'link left', onclick: () => { upcoming = true; redraw(); } }, 'Show all upcoming'));
  }

  fill(container,
    head({
      eyebrow: formatHeadDay(selected),
      title: 'Meetings',
      right: h('button', { type: 'button', class: 'icon-btn add-round', 'aria-label': 'Schedule a meeting', onclick: () => openSchedule(app, { day: selected }) }, icon('plus', 22)),
    }),
    strip,
    week,
    ...body);
  ctx.fab(null);
}

// ---- the route menu ---------------------------------------------------------------------------------------------------

function openRouteMenu(app, routeId) {
  const route = app.store.routeById(routeId);
  if (!route) return;

  const sheet = openBottomSheet({
    label: `Options for ${route.title}`,
    head: h('div', null, h('p', { class: 'eyebrow' }, 'Route'), h('h2', { class: 'route-title' }, route.title)),
    body: h('div', { class: 'sheet-list' }, [
      ['Rename', () => renameRoute(app, route.id)],
      ['Reorder stops', () => openReorder(app, route.id)],
      ['Change start time', () => changeStart(app, route.id)],
      ['Delete route', () => deleteRoute(app, route.id)],
    ].map(([label, act]) => h('button', { type: 'button', class: 'sheet-option', onclick() { sheet.close(); act(); } }, label))),
  });
}

async function renameRoute(app, routeId) {
  const route = app.store.routeById(routeId);
  if (!route) return;

  const input = businessInput({ value: route.title, maxLength: 60 });
  const box = field('Route name', input);
  const name = await dialog({
    title: 'Rename route',
    content: box.el,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save',
        primary: true,
        onclick(event, finish) {
          const problem = rules.businessName(input.value, { label: 'Route name', max: 60 });
          box.setError(problem);
          if (!problem) finish(tidy(input.value));
        },
      },
    ],
  });
  if (name) await app.store.saveRoute({ id: route.id, title: name, stops_order: route.stops_order });
}

// The times of the stops that have not happened yet, spaced from the start time; stops already logged and times set by hand stay.
function respace(store, route, stops, startTime) {
  const times = {};
  spaceTimes(stops, startTime).forEach((at, i) => {
    if (isOpen(stops[i]) && at.getTime() !== timeOf(stops[i]).getTime()) times[stops[i].id] = at.toISOString();
  });
  return { id: route.id, start_time: startTime, stops_order: stops.map((s) => s.id), times };
}

async function changeStart(app, routeId) {
  const store = app.store;
  const route = store.routeById(routeId);
  if (!route) return;

  const input = timeInput({ value: route.start_time, pickerTitle: 'First stop at', 'aria-label': 'Start time' });
  const box = field('First stop at', input);
  const time = await dialog({
    title: 'Change start time',
    content: h('div', { class: 'stack' }, box.el, h('p', { class: 'muted small' }, 'The stops that have not happened yet move to match. A time you set yourself stays.')),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: 'ok' }],
  });
  if (time !== 'ok') return;

  try {
    await store.saveRoute(respace(store, route, store.routeStops(route.id), input.value));
  } catch (error) {
    toast(error.message || 'Could not save.');
  }
}

async function deleteRoute(app, routeId) {
  const route = app.store.routeById(routeId);
  if (route && await confirmDialog({ title: 'Delete this route?', text: `The meetings of "${route.title}" stay as single meetings.`, yes: 'Delete route' })) {
    await app.store.deleteRoute(route.id);
  }
}

// ---- reorder the stops ------------------------------------------------------------------------------------------------

function openReorder(app, routeId) {
  const store = app.store;
  const route = store.routeById(routeId);
  if (!route) return;

  let order = store.routeStops(route.id).map((s) => s.id);
  const list = h('div', { class: 'reorder', role: 'list' });
  const byId = new Map(store.routeStops(route.id).map((s) => [s.id, s]));

  const draw = () => list.replaceChildren(...order.map((id, i) => {
    const stop = byId.get(id);
    const row = h('div', { class: 'reorder-row', role: 'listitem', dataset: { id } },
      h('span', { class: 'grip', 'aria-hidden': 'true' }, icon('grip', 20)),
      h('span', { class: 'grow' }, h('span', { class: 'title' }, `${i + 1}. ${stop.client_name}`), h('span', { class: 'sub' }, `${formatTime(timeOf(stop))}${isOpen(stop) ? '' : ' · already ' + statusOf(stop)}`)),
      h('button', { type: 'button', class: 'icon-btn small', 'aria-label': `Move ${stop.client_name} up`, disabled: i === 0, onclick() { swap(i, i - 1); } }, icon('up', 18)),
      h('button', { type: 'button', class: 'icon-btn small', 'aria-label': `Move ${stop.client_name} down`, disabled: i === order.length - 1, onclick() { swap(i, i + 1); } }, icon('down', 18)));

    // drag by the handle: the row follows the finger and the others make room (the buttons do the same for anyone who cannot drag)
    row.querySelector('.grip').addEventListener('pointerdown', (event) => {
      event.preventDefault();
      row.classList.add('dragging');

      const move = (e) => {
        for (const other of [...list.children]) {
          if (other === row) continue;
          const box = other.getBoundingClientRect();
          if (e.clientY > box.top && e.clientY < box.bottom) {
            const before = e.clientY < box.top + box.height / 2;
            list.insertBefore(row, before ? other : other.nextSibling);
            break;
          }
        }
      };
      // listened to on the window: moving the row in the list would release a pointer captured by the handle
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        order = [...list.children].map((r) => r.dataset.id);
        draw();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    return row;
  }));

  const swap = (a, b) => {
    [order[a], order[b]] = [order[b], order[a]];
    draw();
  };

  const save = h('button', { class: 'btn primary block' }, 'Save order');
  save.addEventListener('click', async () => {
    const stops = order.map((id) => byId.get(id));
    save.disabled = true;
    try {
      await store.saveRoute(respace(store, route, stops, route.start_time));
      toast('Order saved. Times of the stops to come were recalculated.');
      page.close();
    } catch (error) {
      toast(error.message || 'Could not save.');
      save.disabled = false;
    }
  });

  draw();
  const page = openPage({
    title: 'Reorder stops',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Drag the handle, or use the arrows. The times of the stops that have not happened yet follow the new order, 90 minutes apart. A time you set yourself stays.'), list),
    footer: save,
  });
}
