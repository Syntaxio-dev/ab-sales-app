import { PURPOSES, ROUTE_MINUTES, atTime, defaultSlot, plannedWindowProblem, startOfDay, timeText } from '../core/meeting.js';
import { MAX_STOPS, areaOf, fitsOneDay, plannedTimes, searchStops, stopFromClient, stopFromProspect, titleFor } from '../core/route-plan.js';
import * as rules from '../core/rules.js';
import { cleanAreas, outcomeLabel } from '../core/prospect.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { formatTime, initials } from './format.js';
import { businessInput } from './inputs.js';
import { openPage, slot, toast, validate } from './kit.js';
import { shortDay, whenChips } from './when-chips.js';

// "Plan a route": one day, several companies. The rep searches ONE list that holds the clients (the ones the office gave, and all the others
// on the phone) and the prospects, ticks the companies in the order of the visit, and gets one route with a planned meeting for each (the
// first at the start time, the next ones 90 minutes apart, which the Meetings tab already knows how to show and the rep can move later).

const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function openRoutePlan(app, { day = null } = {}) {
  const store = app.store;
  const now = new Date();

  const state = {
    when: day && startOfDay(day) > startOfDay(now) ? atTime(day, '10:00') : defaultSlot(now),
    touched: false,
    stops: [],        // [{ key, kind, id, name, place }] in the order of the visit
    search: '',
    title: '',
    titleTouched: false,
    purpose: '',
  };
  let page = null;

  // ---- when ------------------------------------------------------------------------------------------------------------
  const whenSlot = slot(h('div', { class: 'stack' }), null);
  const chips = whenChips(state, { onChange() { whenSlot.setError(null); drawStops(); } });
  whenSlot.el.querySelector('.stack')?.append(chips.days, chips.times);

  // ---- the stops chosen so far -----------------------------------------------------------------------------------------
  const stopsBox = h('div', null);
  const stopsSlot = slot(stopsBox, null);

  const move = (i, by) => {
    const j = i + by;
    if (j < 0 || j >= state.stops.length) return;
    [state.stops[i], state.stops[j]] = [state.stops[j], state.stops[i]];
    drawStops();
  };
  const remove = (key) => {
    state.stops = state.stops.filter((s) => s.key !== key);
    drawStops();
    drawResults();
  };

  function drawStops() {
    const times = plannedTimes(state.when, state.stops.length);
    if (!state.titleTouched) titleInput.value = state.stops.length ? titleFor(state.stops) : '';

    stopsBox.replaceChildren(...[
      h('p', { class: 'eyebrow' }, state.stops.length ? `Your route · ${state.stops.length} ${state.stops.length === 1 ? 'stop' : 'stops'}` : 'Your route'),
      state.stops.length
        ? h('div', { class: 'list' }, state.stops.map((s, i) => h('div', { class: 'item route-stop' },
          h('span', { class: 'avatar' }, String(i + 1)),
          h('span', { class: 'grow' },
            h('span', { class: 'title' }, s.name),
            h('span', { class: 'sub' }, [s.kind === 'prospect' ? 'Prospect' : 'Client', s.place, formatTime(times[i])].filter(Boolean).join(' · '))),
          h('span', { class: 'item-actions' },
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move ${s.name} up`, disabled: i === 0, onclick: () => move(i, -1) }, icon('up', 18)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move ${s.name} down`, disabled: i === state.stops.length - 1, onclick: () => move(i, 1) }, icon('down', 18)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${s.name}`, onclick: () => remove(s.key) }, icon('close', 18))))))
        : h('p', { class: 'muted small' }, 'Search below and tap the companies you will visit, in order.'),
      state.stops.length ? h('p', { class: 'muted small' }, `The first stop is at ${formatTime(state.when)}, the next ones ${ROUTE_MINUTES} minutes apart. You can change a time later.`) : null,
    ].filter(Boolean));
  }

  // ---- search: clients AND prospects in one list -----------------------------------------------------------------------
  const searchInput = businessInput({ placeholder: 'Search clients and prospects', 'aria-label': 'Search clients and prospects' });
  const searchBox = h('div', { class: 'guide-search enq-search' }, icon('search', 20), searchInput);
  const resultsBox = h('div', { class: 'stack' });

  const chosen = (key) => state.stops.some((s) => s.key === key);
  function toggle(stop) {
    if (chosen(stop.key)) state.stops = state.stops.filter((s) => s.key !== stop.key);
    else if (state.stops.length >= MAX_STOPS) return void toast(`A route holds at most ${MAX_STOPS} stops.`);
    else state.stops.push(stop);

    stopsSlot.setError(null);
    drawStops();
    drawResults();
  }

  const row = (stop, sub) => h('button', { type: 'button', class: 'item pick', role: 'checkbox', 'aria-checked': String(chosen(stop.key)), onclick: () => toggle(stop) },
    h('span', { class: 'avatar' }, initials(stop.name)),
    h('span', { class: 'grow' }, h('span', { class: 'title' }, stop.name), sub ? h('span', { class: 'sub' }, sub) : null),
    chosen(stop.key) ? h('span', { class: 'tick' }, icon('check', 15)) : null);

  function drawResults() {
    const text = tidy(state.search);
    const statuses = store.prospectStatuses();
    const found = searchStops({
      clients: store.clients,
      prospects: store.prospects,
      status: (id) => statuses.get(id),
      me: store.profile?.employee_code ?? null,
      areas: cleanAreas(store.prefs.prospect_areas),
    }, text, { max: text ? 10 : 8 });

    const me = store.profile?.employee_code;
    const givenToMe = !text && found.clients.some((c) => c.assigned_to_code === me);
    const clientRows = found.clients.map((c) => row(stopFromClient(c), [c.city, !givenToMe && c.assigned_to_name && c.assigned_to_code !== me ? `Works with ${c.assigned_to_name}` : null].filter(Boolean).join(' · ')));
    const prospectRows = found.prospects.map((p) => {
      const status = statuses.get(p.id);
      return row(stopFromProspect(p), [p.territory, status?.outcome && status.outcome !== 'new' ? outcomeLabel(status.outcome) : 'Not called yet'].join(' · '));
    });

    resultsBox.replaceChildren(...[
      clientRows.length ? h('div', null, h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, text ? 'Clients' : givenToMe ? 'Clients given to you' : 'Clients'), h('div', { class: 'list' }, clientRows)) : null,
      prospectRows.length ? h('div', null, h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, text ? 'Prospects' : 'Prospects in your territories'), h('div', { class: 'list' }, prospectRows)) : null,
      !clientRows.length && !prospectRows.length ? h('p', { class: 'muted small' }, text ? 'No client or prospect found. Add the company under Clients first.' : 'No clients or prospects yet. Add them under Clients, then plan the route.') : null,
      !text && (clientRows.length || prospectRows.length) ? h('p', { class: 'muted small' }, 'Not here? Type a name, place or number above.') : null,
    ].filter(Boolean));
  }
  searchInput.addEventListener('input', () => { state.search = searchInput.value; drawResults(); });

  // ---- name and purpose ---------------------------------------------------------------------------------------------------
  const titleInput = businessInput({ maxLength: 60, placeholder: 'For example Bagru run', 'aria-label': 'Route name' });
  titleInput.addEventListener('input', () => { state.titleTouched = true; });
  const titleSlot = slot(h('div', { class: 'stack' }, h('p', { class: 'eyebrow' }, 'Route name (optional)'), titleInput), titleInput);

  const purposeBox = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Purpose' });
  function drawPurpose() {
    purposeBox.replaceChildren(...PURPOSES.map((p) => h('button', {
      type: 'button', class: 'filter', role: 'radio', 'aria-checked': String(state.purpose === p),
      onclick() { state.purpose = state.purpose === p ? '' : p; drawPurpose(); },
    }, p)));
  }

  // ---- save ------------------------------------------------------------------------------------------------------------------
  const save = h('button', { class: 'btn primary block' }, icon('route', 18), 'Plan route');
  save.addEventListener('click', async () => {
    const times = plannedTimes(state.when, state.stops.length);
    const title = tidy(titleInput.value) || titleFor(state.stops);

    const ok = validate([
      [stopsSlot, state.stops.length < 2 ? 'Pick at least two companies. For one visit use "Schedule a meeting".' : !fitsOneDay(times) ? 'Too many stops for one day. Start earlier or remove a stop.' : null],
      [whenSlot, plannedWindowProblem(state.when)],
      [titleSlot, rules.businessName(title, { label: 'Route name', max: 60 })],
    ]);
    if (!ok) return;

    save.disabled = true;
    const made = [];
    try {
      for (const [i, stop] of state.stops.entries()) {
        const iso = times[i].toISOString();
        const meeting = await store.saveMeeting({
          client_id: stop.kind === 'client' ? stop.id : null,
          prospect_id: stop.kind === 'prospect' ? stop.id : null,
          client_name: stop.name,
          contact_ids: [],
          meeting_at: iso,
          scheduled_at: iso,
          status: 'planned',
          purpose: state.purpose,
          time_manual: false,
        });
        made.push(meeting.id);
      }

      await store.saveRoute({ title, area: areaOf(state.stops), stops_order: made, start_time: timeText(state.when) });
      toast(`Route planned: ${made.length} stops on ${shortDay(state.when)}.`);
      page.close();
    } catch (error) {
      // all or nothing: the meetings made so far are taken back
      for (const id of made) await store.deleteMeeting(id).catch(() => {});
      save.disabled = false;
      toast(error instanceof ValidationError ? error.message : 'Could not plan the route. Please try again.');
    }
  });

  page = openPage({
    title: 'Plan a route',
    body: h('div', { class: 'stack sched' },
      h('p', { class: 'muted' }, 'Visiting several companies in one day? Pick them all here, clients and prospects, in the order you will go.'),
      whenSlot.el,
      stopsSlot.el,
      h('div', { class: 'stack' }, h('p', { class: 'eyebrow' }, 'Add companies'), searchBox, resultsBox),
      titleSlot.el,
      h('div', { class: 'stack' }, h('p', { class: 'eyebrow' }, 'Purpose (optional)'), purposeBox)),
    footer: save,
  });

  drawStops();
  drawResults();
  drawPurpose();
}
