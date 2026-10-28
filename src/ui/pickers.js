import { h, icon } from './dom.js';
import { pad } from './format.js';
import { dialog } from './kit.js';

// Date and time pickers in the app's own look (the phone's built-in pickers ignore the theme). A picker box behaves like an input:
// `.value` is "YYYY-MM-DD" (date) or "YYYY-MM-DDTHH:mm" (date and time) and it sends `input` / `change` events when the person picks.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// "Mon, 26 Oct 2026": written by hand, because the browsers' own formats differ in where the commas go
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shownDay = { format: (d) => `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}` };
const shownTime = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

// "2026-10-26T16:30" -> { y: 2026, mo: 9, d: 26, hh: 16, mm: 30 } (mo counts from 0 like Date), or null
export function parseValue(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(value ?? ''));
  return m ? { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]), hh: Number(m[4] ?? 0), mm: Number(m[5] ?? 0) } : null;
}

const toDate = (p) => new Date(p.y, p.mo, p.d, p.hh, p.mm);
const dayKey = (y, mo, d) => y * 10_000 + mo * 100 + d;

// "16:30" -> { hh: 16, mm: 30 }, or null
const parseTime = (value) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  return m ? { hh: Number(m[1]), mm: Number(m[2]) } : null;
};

export function formatPicked(kind, value) {
  if (kind === 'time') {
    const t = parseTime(value);
    return t ? shownTime.format(new Date(2000, 0, 1, t.hh, t.mm)) : '';
  }
  const p = parseValue(value);
  if (!p) return '';
  const date = toDate(p);
  return kind === 'date' ? shownDay.format(date) : `${shownDay.format(date)} · ${shownTime.format(date)}`;
}

function composeValue(kind, p) {
  if (kind === 'time') return `${pad(p.hh)}:${pad(p.mm)}`;
  const day = `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
  return kind === 'date' ? day : `${day}T${pad(p.hh)}:${pad(p.mm)}`;
}

// The limits as comparable text: a date limit has no time, a date-time limit is padded to the start / end of its day.
function limit(kind, text, end) {
  if (!text) return null;
  if (kind === 'date') return String(text).slice(0, 10);
  return String(text).length > 10 ? String(text) : `${text}T${end ? '23:59' : '00:00'}`;
}

/**
 * Opens the picker. Resolves with the picked value, or undefined when the person cancels.
 * kind: 'date' | 'datetime' | 'time' (hour and minute only, value "HH:mm"). min / max: the same text format as the value.
 */
export function openPicker(kind, { value = '', min = '', max = '', title = kind === 'date' ? 'Pick a date' : kind === 'time' ? 'Pick a time' : 'Pick a date and time' } = {}) {
  const now = new Date();
  const sel = (kind === 'time' ? parseTime(value) && { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate(), ...parseTime(value) } : parseValue(value)) ?? { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate(), hh: now.getHours(), mm: now.getMinutes() };
  const view = { y: sel.y, mo: sel.mo };
  let tab = kind === 'time' ? 'time' : 'date';

  const lowest = limit(kind, min, false);
  const highest = limit(kind, max, true);
  const lowDay = lowest ? parseValue(lowest.slice(0, 10)) : null;
  const highDay = highest ? parseValue(highest.slice(0, 10)) : null;
  const blocked = (y, mo, d) => (lowDay && dayKey(y, mo, d) < dayKey(lowDay.y, lowDay.mo, lowDay.d)) || (highDay && dayKey(y, mo, d) > dayKey(highDay.y, highDay.mo, highDay.d));

  const summary = h('p', { class: 'picker-summary' });
  const error = h('p', { class: 'err', role: 'alert' });
  const body = h('div', { class: 'picker-body' });
  const tabs = h('div', { class: 'seg two', role: 'tablist' });

  const redrawSummary = () => {
    summary.textContent = formatPicked(kind, composeValue(kind, sel));
  };

  // ---- the calendar ----
  const step = (months) => {
    const next = new Date(view.y, view.mo + months, 1);
    view.y = next.getFullYear();
    view.mo = next.getMonth();
    draw();
  };

  const nav = (label, glyph, onclick) => h('button', { type: 'button', class: 'cal-nav', 'aria-label': label, onclick }, glyph);

  function drawCalendar() {
    const first = new Date(view.y, view.mo, 1).getDay();
    const days = new Date(view.y, view.mo + 1, 0).getDate();
    const today = new Date();
    const cells = [];

    for (const w of WEEKDAYS) cells.push(h('span', { class: 'cal-week', 'aria-hidden': 'true' }, w));
    for (let i = 0; i < first; i++) cells.push(h('span', { 'aria-hidden': 'true' }));
    for (let d = 1; d <= days; d++) {
      const chosen = sel.y === view.y && sel.mo === view.mo && sel.d === d;
      const isToday = today.getFullYear() === view.y && today.getMonth() === view.mo && today.getDate() === d;
      cells.push(h('button', {
        type: 'button', class: `cal-day${isToday ? ' today' : ''}`, 'aria-pressed': String(chosen), disabled: Boolean(blocked(view.y, view.mo, d)),
        'aria-label': `${d} ${MONTHS[view.mo]} ${view.y}`,
        onclick() {
          Object.assign(sel, { y: view.y, mo: view.mo, d });
          error.textContent = '';
          draw();
        },
      }, String(d)));
    }

    body.replaceChildren(
      h('div', { class: 'cal-head' },
        nav('Previous year', '«', () => step(-12)), nav('Previous month', '‹', () => step(-1)),
        h('strong', { class: 'grow' }, `${MONTHS[view.mo]} ${view.y}`),
        nav('Next month', '›', () => step(1)), nav('Next year', '»', () => step(12))),
      h('div', { class: 'cal-grid' }, cells));
  }

  // ---- the time: hour, minute, am / pm ----
  function drawTime() {
    const hour12 = sel.hh % 12 || 12;
    const pm = sel.hh >= 12;
    const setHour = (h12, isPm) => { sel.hh = (h12 % 12) + (isPm ? 12 : 0); };

    const wheel = (label, items, current, onPick) => h('div', { class: 'wheel', role: 'listbox', 'aria-label': label },
      items.map(([text, val]) => h('button', {
        type: 'button', class: 'wheel-item', role: 'option', 'aria-selected': String(val === current),
        onclick() { onPick(val); error.textContent = ''; draw(); },
      }, text)));

    const hours = wheel('Hour', Array.from({ length: 12 }, (_, i) => [String(i + 1), i + 1]), hour12, (v) => setHour(v, pm));
    const minutes = wheel('Minute', Array.from({ length: 60 }, (_, i) => [pad(i), i]), sel.mm, (v) => { sel.mm = v; });
    const half = h('div', { class: 'wheel half', role: 'listbox', 'aria-label': 'AM or PM' },
      [['AM', false], ['PM', true]].map(([text, isPm]) => h('button', {
        type: 'button', class: 'wheel-item', role: 'option', 'aria-selected': String(isPm === pm),
        onclick() { setHour(hour12, isPm); error.textContent = ''; draw(); },
      }, text)));

    body.replaceChildren(h('div', { class: 'wheels' }, hours, h('span', { class: 'wheel-colon', 'aria-hidden': 'true' }, ':'), minutes, half));

    // bring the chosen hour and minute to the middle of their lists
    requestAnimationFrame(() => {
      for (const list of [hours, minutes]) {
        const on = list.querySelector('[aria-selected="true"]');
        if (on) list.scrollTop = on.offsetTop - list.clientHeight / 2 + on.offsetHeight / 2;
      }
    });
  }

  function draw() {
    redrawSummary();
    tabs.replaceChildren(...(kind === 'datetime'
      ? [['date', 'Date'], ['time', 'Time']].map(([id, text]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick() { tab = id; draw(); } }, text))
      : []));
    tabs.hidden = kind !== 'datetime';
    if (tab === 'date') drawCalendar();
    else drawTime();
  }

  const jump = h('button', {
    type: 'button', class: 'link', style: { padding: '0', minHeight: '0' },
    onclick() {
      const t = new Date();
      Object.assign(sel, { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate() });
      if (kind !== 'date') Object.assign(sel, { hh: t.getHours(), mm: t.getMinutes() });
      Object.assign(view, { y: sel.y, mo: sel.mo });
      error.textContent = '';
      draw();
    },
  }, kind === 'date' ? 'Today' : 'Now');

  const content = h('div', { class: 'stack picker' }, h('div', { class: 'picker-top' }, summary, jump), tabs, body, error);
  draw();

  return dialog({
    title,
    content,
    buttons: [
      { label: 'Cancel', value: undefined },
      {
        label: 'OK',
        primary: true,
        onclick(event, finish) {
          const picked = composeValue(kind, sel);
          if (lowest && picked < lowest) return void (error.textContent = 'That is earlier than allowed.');
          if (highest && picked > highest) return void (error.textContent = 'That is later than allowed.');
          finish(picked);
        },
      },
    ],
  });
}

// ---- the boxes ----

function makePicker(kind, { value = '', min = '', max = '', placeholder = kind === 'date' ? 'Pick a date' : kind === 'time' ? 'Pick a time' : 'Pick a date and time', pickerTitle, 'aria-label': ariaLabel = null } = {}) {
  let current = value;
  const text = h('span', { class: 'picker-text' });
  const el = h('button', { type: 'button', class: 'input picker', 'aria-haspopup': 'dialog' }, text, icon(kind === 'date' ? 'calendar' : 'alarm', 18));
  el.min = min;
  el.max = max;
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel);

  const show = () => {
    text.textContent = current ? formatPicked(kind, current) : placeholder;
    text.classList.toggle('empty', !current);
  };

  // `.value` works like an input's, so the forms read and clear it the usual way
  Object.defineProperty(el, 'value', { get: () => current, set: (v) => { current = v || ''; show(); } });

  el.addEventListener('click', async () => {
    const picked = await openPicker(kind, { value: current, min: el.min, max: el.max, title: pickerTitle });
    if (picked === undefined) return;

    current = picked;
    show();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  show();
  return el;
}

/** A date box: value "YYYY-MM-DD". */
export const dateInput = (props = {}) => makePicker('date', props);

/** A time box (hour, minute, am / pm): value "HH:mm". */
export const timeInput = (props = {}) => makePicker('time', props);

/** A date and time box: value "YYYY-MM-DDTHH:mm" (local time). */
export const dateTimeInput = (props = {}) => makePicker('datetime', props);
