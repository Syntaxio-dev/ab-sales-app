import { h, icon } from './dom.js';
import { callLabel, openClientPage } from './clients.js';
import { dayLabel, formatDayTime, formatTime, initials, sameDay } from './format.js';
import { confirmDialog, toast } from './kit.js';
import { openAddNumber } from './people.js';
import { empty, fill, head } from './parts.js';

// The Calls tab: calls with numbers saved in the client pool (their name comes from the pool), and the numbers that are not saved yet.
// It reads the phone's call history only after the rep turned it on (and Android allowed it). Calls with numbers that are not in the
// pool are never saved or sent: they are only shown here, from memory, so a new client can be saved.

const MAX_SHOWN = 60;
const REFRESH_EVERY_MS = 20_000;

let lastState = null; // so the screen does not flash "off" while the answer is on its way
let lastRefresh = 0;

export function resetCallsView() {
  lastState = null;
  lastRefresh = 0;
}

// The person turns call matching on: say what is read and kept, then Android asks. -> the new state, or null when they said no.
export async function askTurnOn(app) {
  const ok = await confirmDialog({
    title: 'Allow call matching?',
    text: 'The app reads your call history (number, time and length). It keeps only calls with numbers saved in your clients and sends those to the office. Android will ask for permission next.',
    yes: 'Continue',
    danger: false,
  });
  if (!ok) return null;

  lastState = await app.enableCallMatching();
  lastRefresh = Date.now();
  return lastState;
}

export async function askTurnOff(app) {
  const ok = await confirmDialog({ title: 'Turn off call matching?', text: 'The app stops reading your call history. Calls already saved stay.', yes: 'Turn off', danger: false });
  if (!ok) return null;

  await app.disableCallMatching();
  lastState = 'off';
  return lastState;
}

export function renderCalls(container, app, ctx) {
  const store = app.store;
  const body = h('div', { class: 'stack' });
  let state = lastState ?? (store.prefs.call_matching === true ? 'on' : 'off');

  const consent = (denied) => h('div', { class: 'card pad stack' },
    h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Call matching'),
    h('h2', { style: { fontSize: '19px' } }, 'See which clients called you'),
    h('p', { class: 'muted' }, 'AB Sales can look at your phone\'s call history and show the calls you had with the clients saved in the app, with the client\'s name and the person\'s position.'),
    h('ul', { class: 'muted small', style: { paddingLeft: '18px', display: 'grid', gap: '6px' } },
      h('li', null, 'Only calls with numbers saved in your clients are kept, and sent to the office with your other records.'),
      h('li', null, 'Other calls (family, friends) are never saved or sent. Their numbers are only shown to you here, so you can save a new client.'),
      h('li', null, 'Nothing is read until you allow it. You can turn it off any time.')),
    denied ? h('p', { class: 'err' }, 'Android did not allow it. You can allow "Call logs" for AB Sales in the phone\'s Settings > Apps > AB Sales > Permissions.') : null,
    h('button', { class: 'btn primary block', onclick: turnOn }, denied ? 'Try again' : 'Turn on call matching'));

  async function turnOn() {
    state = (await askTurnOn(app)) ?? state;
    draw();
  }

  async function turnOff() {
    state = (await askTurnOff(app)) ?? state;
    draw();
  }

  async function refresh(button) {
    if (button) button.disabled = true;
    const { added } = await app.refreshCalls();
    lastRefresh = Date.now();
    if (button) button.disabled = false;
    toast(added ? `${added} new ${added === 1 ? 'call' : 'calls'}` : 'Nothing new');
    draw();
  }

  const callRow = (call) => {
    const person = store.contactById(call.contact_id);
    const client = store.clientById(call.client_id);
    const title = call.contact_name || call.client_name || call.number;
    const sub = [call.contact_name ? call.client_name : null, person?.position, formatTime(new Date(call.started_at))].filter(Boolean).join(' · ');

    return h('button', { class: 'item', onclick: () => client && openClientPage(app, client.id) },
      h('span', { class: 'avatar' }, initials(call.client_name || title)),
      h('span', { class: 'grow' }, h('span', { class: 'title' }, title), h('span', { class: 'sub' }, sub)),
      h('span', { class: 'end' }, h('span', { class: `chip ${call.direction}` }, callLabel(call))));
  };

  const unknownRow = (u) => h('div', { class: 'item' },
    h('span', { class: 'avatar' }, '?'),
    h('span', { class: 'grow' }, h('span', { class: 'title' }, u.number), h('span', { class: 'sub' }, `${u.count} ${u.count === 1 ? 'call' : 'calls'} · last ${formatDayTime(new Date(u.last))}`)),
    h('button', { class: 'btn small-btn', onclick: () => openAddNumber(app, u.number) }, icon('userplus', 18), 'Save'));

  function draw() {
    if (state !== 'on') {
      fill(body, consent(state === 'denied'), empty('phone', 'No calls to show', 'Turn on call matching to see your client calls here.'));
      return;
    }

    const now = new Date();
    const calls = store.calls.slice(0, MAX_SHOWN);
    const today = store.calls.filter((c) => sameDay(new Date(c.started_at), now)).length;
    const week = store.calls.filter((c) => now - new Date(c.started_at) < 7 * 86_400_000).length;

    const rows = [];
    let lastDay = null;
    for (const call of calls) {
      const day = new Date(call.started_at);
      if (!lastDay || !sameDay(day, lastDay)) {
        lastDay = day;
        rows.push(h('p', { class: 'day-label' }, dayLabel(day)));
      }
      rows.push(callRow(call));
    }

    const unknown = app.unknownCalls.slice(0, 10);

    fill(body,
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('p', { class: 'eyebrow' }, 'Calls today'), h('div', { class: 'num' }, String(today)), h('div', { class: 'hint' }, 'With clients')),
        h('div', { class: 'tile' }, h('p', { class: 'eyebrow' }, 'Last 7 days'), h('div', { class: 'num' }, String(week)), h('div', { class: 'hint' }, 'With clients'))),

      rows.length ? h('div', { class: 'list' }, rows) : empty('phone', 'No client calls yet', 'Calls with numbers saved in your clients show up here. Save a client\'s number first.'),

      unknown.length ? h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Numbers not saved yet'),
        h('div', { class: 'list' }, unknown.map(unknownRow)),
        h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'Only you see this list. Nothing in it is saved or sent unless you save the number as a client.')) : null,

      h('p', { class: 'muted small', style: { textAlign: 'center', marginTop: '12px' } },
        'Only calls with numbers saved in your clients are kept and sent to the office. ',
        h('button', { class: 'link', style: { padding: '0', minHeight: '0', font: 'inherit' }, onclick: turnOff }, 'Turn off')));
  }

  const refreshButton = h('button', { class: 'icon-btn', 'aria-label': 'Check for new calls', onclick: (e) => refresh(e.currentTarget) }, icon('refresh', 20));

  fill(container,
    head({ eyebrow: state === 'on' ? 'Matched with your clients' : 'Call matching is off', title: 'Calls', right: state === 'on' ? refreshButton : null }),
    body);
  ctx.fab(null);
  draw();

  // find out the real state (Android may have taken the permission back), and read the history when it is a while since the last time
  void app.callMatchingState().then(async (real) => {
    if (real !== state) {
      state = lastState = real;
      draw();
    } else lastState = real;

    if (real === 'on' && Date.now() - lastRefresh > REFRESH_EVERY_MS) {
      lastRefresh = Date.now();
      await app.refreshCalls();
      draw();
    }
  });
}
