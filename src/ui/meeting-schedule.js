import {
  PURPOSES, ROUTE_MINUTES, atTime, clashWith, dayKey, defaultSlot, plannedWindowProblem, routeTitleFor, startOfDay, suggestRoute, suggestRun, timeOf, timeText,
} from '../core/meeting.js';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { clientPicker } from './client-picker.js';
import { h, icon } from './dom.js';
import { formatTime, initials } from './format.js';
import { businessInput } from './inputs.js';
import { confirmDialog, openPage, slot, toast, validate } from './kit.js';
import { openVisit } from './meeting-visit.js';
import { shortDay, whenChips } from './when-chips.js';

// "Schedule a meeting": one short page. Client, day, time, purpose; a card offers to join a route when the rep is in the same place that
// day. Editing a planned meeting uses the same page. (A reminder before the meeting is not here: the app has no notification helper.)

const MINUTE = 60_000;
const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function openSchedule(app, { existing = null, day = null, client_id: presetClient = null } = {}) {
  const store = app.store;
  const now = new Date();

  const first = existing ? new Date(existing.scheduled_at ?? existing.meeting_at) : (() => {
    if (day && startOfDay(day) > startOfDay(now)) return atTime(day, '10:00');
    return defaultSlot(now);
  })();

  const wanted = existing?.client_id ?? presetClient;
  const known = wanted && store.clientById(wanted) ? wanted : null;
  const typedFirst = existing && !known ? existing.client_name : '';

  const state = {
    clientId: known,
    other: Boolean(typedFirst),
    clientName: typedFirst,
    search: '',
    when: first,
    touched: Boolean(existing?.time_manual),
    autoApplied: false,
    purpose: existing?.purpose ? (PURPOSES.includes(existing.purpose) ? existing.purpose : 'other') : '',
    purposeOther: existing?.purpose && !PURPOSES.includes(existing.purpose) ? existing.purpose : '',
    routeChoice: null, // 'join' | 'run' | 'keep'
    routeKey: null,
    beforeAuto: null,
  };
  let changing = !state.clientId && !state.other;
  let page = null;

  const cityOf = (m) => store.clientById(m.client_id)?.city ?? '';
  const clientCity = () => (state.clientId ? store.clientById(state.clientId)?.city ?? '' : '');

  // ---- who ------------------------------------------------------------------------------------------------------------

  const clientBox = h('div', { class: 'stack' });
  const clientSlot = slot(clientBox, null);
  const picker = clientPicker(app, state, {
    onPick() {
      changing = false;
      clientSlot.setError(null);
      drawClient();
      drawRoute();
    },
  });

  function drawClient() {
    if ((state.clientId || state.other) && !changing) {
      const client = state.clientId ? store.clientById(state.clientId) : null;
      const name = client ? client.name : tidy(state.clientName);
      const person = client ? store.contactsOf(client.id)[0] : null;
      const sub = client ? [client.city, person ? `${person.name}${person.position ? ` · ${person.position}` : ''}` : null].filter(Boolean).join(' · ') : 'New client name, not saved in the client list';

      clientBox.replaceChildren(h('div', { class: 'card pad sched-client' },
        h('span', { class: 'avatar' }, initials(name)),
        h('span', { class: 'grow' }, h('span', { class: 'title' }, name), sub ? h('span', { class: 'sub' }, sub) : null),
        h('button', { type: 'button', class: 'link', onclick() { changing = true; drawClient(); } }, 'Change')));
      return;
    }

    clientBox.replaceChildren(picker.searchBox, picker.slot.el);
  }

  // ---- when -----------------------------------------------------------------------------------------------------------

  const whenSlot = slot(h('div', { class: 'stack' }), null);
  const chips = whenChips(state, {
    onChange() {
      state.autoApplied = false;
      whenSlot.setError(null);
      drawWarning();
      drawRoute();
    },
  });
  whenSlot.el.querySelector('.stack')?.append(chips.days, chips.times);

  const warningBox = h('div', null);
  function drawWarning() {
    const clash = clashWith(store.meetings, state.when, existing?.id);
    warningBox.replaceChildren(...(clash ? [h('div', { class: 'enq-warn', role: 'status' },
      icon('alert', 18),
      h('p', { class: 'grow' }, `This overlaps with ${clash.client_name} at ${formatTime(timeOf(clash))}.`))] : []));
  }

  // ---- route suggestion -----------------------------------------------------------------------------------------------

  const routeBox = h('div', null);

  // the time after the stop before it: 90 minutes later, unless the rep picked a later time themself
  function spacedAfter(stopTime) {
    const auto = new Date(stopTime.getTime() + ROUTE_MINUTES * MINUTE);
    if (dayKey(auto) !== dayKey(state.when)) return state.when; // would pass midnight: keep the chosen time
    return state.touched && state.when > auto ? state.when : auto;
  }

  function drawRoute() {
    const city = clientCity();
    const route = city && !existing?.route_id ? suggestRoute(city, state.when, store.routes) : null;
    const run = city && !route && !existing?.route_id ? suggestRun(city, state.when, store.meetings, cityOf, existing?.id) : null;
    const key = route ? `route:${route.id}` : run ? `run:${run.id}` : null;

    if (key !== state.routeKey) { // another place or day: the earlier answer no longer applies
      if (state.beforeAuto && state.autoApplied) {
        state.when = state.beforeAuto;
        chips.redraw();
      }
      Object.assign(state, { routeKey: key, routeChoice: null, beforeAuto: null, autoApplied: false });
    }

    if (!key || state.routeChoice === 'keep') {
      routeBox.replaceChildren();
      return;
    }

    const dayWord = dayKey(state.when) === dayKey(new Date()) ? 'today' : shortDay(state.when);
    const title = route ? route.title : routeTitleFor(city);
    const withWho = route ? `${route.stops_order.length} stop${route.stops_order.length === 1 ? '' : 's'}` : run.client_name;

    if (state.routeChoice) {
      routeBox.replaceChildren(h('div', { class: 'enq-reminder route-hint' },
        icon('route', 18),
        h('p', { class: 'grow' }, `Stop ${route ? route.stops_order.length + 1 : 2} of ${title}, at ${formatTime(state.when)}.`),
        h('button', { type: 'button', class: 'link', onclick: () => choose(null) }, 'Undo')));
      return;
    }

    routeBox.replaceChildren(h('div', { class: 'route-offer' },
      h('div', { class: 'row' }, icon('route', 18), h('p', { class: 'grow' }, `You are in ${city} ${dayWord} with ${withWho}. Make it one route?`)),
      h('div', { class: 'route-offer-buttons' },
        h('button', { type: 'button', class: 'btn small-btn primary', onclick: () => choose(route ? 'join' : 'run') }, route ? `Add to ${route.title}` : `Make a ${city} run with ${run.client_name}`),
        h('button', { type: 'button', class: 'btn small-btn', onclick: () => choose('keep') }, 'Keep separate'))));
  }

  function choose(choice) {
    const city = clientCity();
    const route = suggestRoute(city, state.when, store.routes);
    const run = route ? null : suggestRun(city, state.when, store.meetings, cityOf, existing?.id);

    if (!choice || choice === 'keep') {
      if (state.beforeAuto && state.autoApplied) state.when = state.beforeAuto;
      Object.assign(state, { routeChoice: choice, beforeAuto: null, autoApplied: false });
    } else {
      const last = route ? store.routeStops(route.id).at(-1) : run;
      state.beforeAuto = state.when;
      const spaced = last ? spacedAfter(timeOf(last)) : state.when;
      state.autoApplied = spaced !== state.when;
      state.when = spaced;
      state.routeChoice = choice;
    }
    chips.redraw();
    drawWarning();
    drawRoute();
  }

  // ---- purpose --------------------------------------------------------------------------------------------------------

  const purposeBox = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Purpose' });
  const otherInput = businessInput({ maxLength: 40, placeholder: 'What is it about?', 'aria-label': 'Purpose', value: state.purposeOther });
  const purposeSlot = slot(h('div', { class: 'stack' }, h('p', { class: 'eyebrow' }, 'Purpose (optional)'), purposeBox, otherInput), otherInput);
  otherInput.addEventListener('input', () => { state.purposeOther = otherInput.value; });

  function drawPurpose() {
    purposeBox.replaceChildren(...[...PURPOSES, 'other'].map((p) => h('button', {
      type: 'button', class: 'filter', role: 'radio', 'aria-checked': String(state.purpose === p),
      onclick() {
        state.purpose = state.purpose === p ? '' : p;
        purposeSlot.setError(null);
        drawPurpose();
        if (state.purpose === 'other') otherInput.focus();
      },
    }, p === 'other' ? 'Other' : p)));
    otherInput.hidden = state.purpose !== 'other';
  }

  // ---- save -----------------------------------------------------------------------------------------------------------

  const save = h('button', { class: 'btn primary block' }, existing ? 'Save changes' : 'Schedule meeting');

  save.addEventListener('click', async () => {
    const client = state.clientId ? store.clientById(state.clientId) : null;
    const typed = tidy(state.clientName);
    const purpose = state.purpose === 'other' ? tidy(state.purposeOther) : state.purpose;
    const changed = !existing || new Date(existing.scheduled_at ?? existing.meeting_at).getTime() !== state.when.getTime();

    const ok = validate([
      [clientSlot, client || (state.other && !rules.businessName(typed, { label: 'Client name' })) ? null : state.other ? rules.businessName(typed, { label: 'Client name' }) : 'Choose a client, or type a new client name.'],
      [whenSlot, changed ? plannedWindowProblem(state.when) : null],
      [purposeSlot, state.purpose === 'other' ? rules.optional(purpose, { max: 40, label: 'Purpose' }) : null],
    ]);
    if (!ok) return;

    const city = clientCity();
    const route = state.routeChoice === 'join' ? suggestRoute(city, state.when, store.routes) : null;
    const run = state.routeChoice === 'run' ? suggestRun(city, state.when, store.meetings, cityOf, existing?.id) : null;
    const iso = state.when.toISOString();

    save.disabled = true;
    try {
      const meeting = await store.saveMeeting({
        id: existing?.id,
        client_id: client?.id ?? null,
        client_name: client ? client.name : typed,
        contact_ids: existing?.contact_ids ?? [],
        meeting_at: iso,
        scheduled_at: iso,
        status: existing ? (changed ? 'moved' : existing.status) : 'planned',
        moved_from: existing && changed ? (existing.scheduled_at ?? existing.meeting_at) : existing?.moved_from ?? null,
        purpose,
        discussion: existing?.discussion ?? '',
        outcome: existing?.outcome ?? '',
        next_followup_at: existing?.next_followup_at ?? null,
        route_id: route ? route.id : existing?.route_id ?? null,
        time_manual: changed ? state.touched && !state.autoApplied : existing?.time_manual ?? false,
      });

      if (run) {
        await store.saveRoute({ title: routeTitleFor(city), area: city, stops_order: [run.id, meeting.id], start_time: timeText(new Date(Math.min(timeOf(run), state.when))) });
      }

      toast(existing ? 'Meeting saved.' : `Scheduled for ${shortDay(state.when)}, ${formatTime(state.when)}.`);
      page.close();
    } catch (error) {
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
      save.disabled = false;
    }
  });

  // ---- the page -------------------------------------------------------------------------------------------------------

  const logIt = existing ? null : h('button', {
    type: 'button', class: 'link left',
    onclick() {
      page.close();
      openVisit(app, null, { log: true, client_id: state.clientId });
    },
  }, 'Already happened? Log it');

  const cancel = existing ? h('button', {
    type: 'button', class: 'link left sched-cancel',
    async onclick() {
      if (await confirmDialog({ title: 'Cancel this meeting?', text: `The meeting with ${existing.client_name} is removed. It cannot be undone.`, yes: 'Cancel meeting' })) {
        await store.deleteMeeting(existing.id);
        page.close();
      }
    },
  }, 'Cancel meeting') : null;

  page = openPage({
    title: existing ? 'Edit meeting' : 'Schedule a meeting',
    body: h('div', { class: 'stack sched' },
      h('div', null, h('div', { class: 'section-head' }, h('p', { class: 'eyebrow' }, 'Client'), logIt), clientSlot.el),
      whenSlot.el,
      warningBox,
      routeBox,
      purposeSlot.el,
      cancel),
    footer: save,
  });

  drawClient();
  drawPurpose();
  drawWarning();
  drawRoute();
}
