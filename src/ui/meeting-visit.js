import {
  BASE_CITY, RESULTS, clashWith, defaultSlot, isOpen, loggedWindowProblem, plannedWindowProblem, resultLabel, statusOf, timeOf,
} from '../core/meeting.js';
import { CHECKIN_RADIUS_M, distanceM, formatDistance, hasLocation } from '../core/geo.js';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { clientPicker } from './client-picker.js';
import { h, icon } from './dom.js';
import { openEnquiryForm } from './enquiry-form.js';
import { formatTime, fromLocalInput, initials, tenAmIn, toLocalInput } from './format.js';
import { openExpenseForm } from './forms.js';
import { confirmDialog, openPage, slot, toast, validate } from './kit.js';
import { checkinChip, readSpot, takeSelfie } from './location.js';
import { openSchedule } from './meeting-schedule.js';
import { dateTimeInput } from './pickers.js';
import { openContactForm } from './people.js';
import { shortDay, whenChips } from './when-chips.js';

// "After the visit": what happened at a meeting (Done, Missed or Move), the result, a note and the follow-up. Also the page that writes up
// a visit nobody planned ("Already happened? Log it", log: true). A visit that is already written can be corrected here.

const MAX_NOTE = 500;
const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const lower = (text) => String(text ?? '').trim().toLowerCase();

const dayWord = (date, now = new Date()) => {
  const key = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (key(date) === key(now)) return 'Today';
  if (key(date) === key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return 'Tomorrow';
  if (key(date) === key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return shortDay(date);
};

// After the last stop of a trip outside the rep's base city: once, ask if the travel expense should be written.
async function tripPrompt(app, route) {
  const store = app.store;
  const stops = store.routeStops(route.id);
  const asked = store.prefs.trip_asked ?? [];

  if (!stops.length || stops.some((s) => isOpen(s)) || !route.area || lower(route.area) === lower(BASE_CITY) || asked.includes(route.id)) return;

  await store.savePrefs({ trip_asked: [...asked.slice(-49), route.id] });
  if (await confirmDialog({ title: 'Add travel expense for this trip?', text: `You have finished the ${route.title}. Write down the travel cost now, while you remember it.`, yes: 'Add expense', danger: false })) {
    openExpenseForm(app);
  }
}

export function openVisit(app, id, { log = false, client_id: presetClient = null } = {}) {
  const store = app.store;
  const now = new Date();
  const m = id ? store.meetingById(id) : null;
  if (id && !m) return;

  const status = m ? statusOf(m) : 'done';
  const wanted = m?.client_id ?? presetClient;
  const known = wanted && store.clientById(wanted) ? wanted : null;

  const state = {
    clientId: known,
    other: Boolean(m && !known),
    clientName: m && !known ? m.client_name : '',
    search: '',
    // null = not answered yet (a meeting still to happen)
    answer: m ? (status === 'done' ? 'done' : status === 'missed' ? 'missed' : null) : 'done',
    result: m?.result ?? null,
    note: m?.discussion ?? '',
    follow: m?.next_followup_at ? 'keep' : 'none', // none | tomorrow | 3days | week | keep (the date already saved)
    met: new Set((m?.contact_ids ?? []).filter((c) => store.contactById(c))),
    when: m && timeOf(m) > now ? timeOf(m) : defaultSlot(now), // for Move
    touched: false,
    logWhen: now,
  };
  // the check-in taken on this page (spot + selfie), not saved yet; an earlier one is on the meeting
  let pending = null;
  let selfieUrl = null;
  let changing = !state.clientId && !state.other;
  let page = null;

  const client = () => (state.clientId ? store.clientById(state.clientId) : null);
  const clientName = () => (client() ? client().name : tidy(state.clientName));

  // ---- the top: tags and the call button ---------------------------------------------------------------------------------

  const top = h('div', { class: 'stack' });

  function drawTop() {
    if (!m) return;
    const route = m.route_id ? store.routeById(m.route_id) : null;
    const stop = route ? store.routeStops(route.id).findIndex((s) => s.id === m.id) + 1 : 0;
    const at = timeOf(m);
    const phone = client()?.phone || store.contactsOf(m.client_id ?? '').find((p) => p.phone)?.phone || '';

    top.replaceChildren(
      h('div', { class: 'visit-tags' },
        h('span', { class: `chip ${isOpen(m) && at < new Date() ? 'late' : 'today'}` }, icon('alarm', 12), `${dayWord(at)} ${formatTime(at)}`),
        route ? h('span', { class: 'chip' }, icon('route', 12), `${route.title}${stop ? ` · stop ${stop}` : ''}`) : null,
        status === 'moved' ? h('span', { class: 'chip' }, 'Moved') : null,
        isOpen(m) ? h('button', { type: 'button', class: 'link visit-edit', onclick: () => openSchedule(app, { existing: store.meetingById(m.id) }) }, icon('edit', 14), 'Edit') : null),
      phone ? h('a', { class: 'btn block visit-call', href: `tel:${phone}` }, icon('phone', 18), 'Call') : null);
  }

  // ---- log mode: which client and when ------------------------------------------------------------------------------

  const clientBox = h('div', { class: 'stack' });
  const clientSlot = slot(clientBox, null);
  const picker = log ? clientPicker(app, state, { onPick() { changing = false; clientSlot.setError(null); drawClient(); drawPeople(); drawCheckin(); } }) : null;

  function drawClient() {
    if (!log) return;
    if ((state.clientId || state.other) && !changing) {
      clientBox.replaceChildren(h('div', { class: 'card pad sched-client' },
        h('span', { class: 'avatar' }, initials(clientName())),
        h('span', { class: 'grow' }, h('span', { class: 'title' }, clientName()), client()?.city ? h('span', { class: 'sub' }, client().city) : null),
        h('button', { type: 'button', class: 'link', onclick() { changing = true; drawClient(); } }, 'Change')));
      return;
    }
    clientBox.replaceChildren(picker.searchBox, picker.slot.el);
  }

  const logWhen = log ? dateTimeInput({ min: '2020-01-01T00:00', max: toLocalInput(new Date(Date.now() + 86_400_000)), value: toLocalInput(now), pickerTitle: 'When was the visit?', 'aria-label': 'When was the visit' }) : null;
  const logSlot = log ? slot(h('div', null, h('p', { class: 'eyebrow' }, 'When did it happen?'), logWhen), logWhen) : null;

  // ---- check in: a selfie at the client, with the spot ----------------------------------------------------------------------

  const checkinBox = h('div', { class: 'card pad stack checkin' });
  const checkinSlot = slot(checkinBox, null);

  const hasCheckin = () => Boolean(pending || m?.checkin_at);

  function drawCheckin() {
    const chosen = client();
    let chip = null;
    if (pending) {
      const away = hasLocation(chosen) ? distanceM(chosen, pending.spot) : null;
      chip = h('span', { class: `chip ${away !== null && away > CHECKIN_RADIUS_M ? 'late' : 'approved'}` }, icon(away !== null && away > CHECKIN_RADIUS_M ? 'alert' : 'pin', 12),
        away === null ? 'Selfie ready · the office has not set the location of this client yet' : away > CHECKIN_RADIUS_M ? `Away from client · ${formatDistance(away)}` : `Checked in · ${formatDistance(away)} from client`);
    } else if (m?.checkin_at) {
      chip = checkinChip(m);
    }

    checkinBox.replaceChildren(
      h('p', { class: 'eyebrow' }, 'Proof of visit'),
      ...(pending && selfieUrl ? [h('img', { class: 'bill', src: selfieUrl, alt: 'Your check-in selfie' })] : []),
      chip ?? h('p', { class: 'muted small' }, state.answer === 'done' ? 'Required to save a finished visit. Take a selfie at the place of the client.' : 'Take a selfie when you reach the client. It proves you went, whatever the result.'),
      h('button', { type: 'button', class: 'btn small-btn', async onclick() { await doCheckin(); } }, icon('camera', 18), hasCheckin() ? 'Retake selfie' : 'Take selfie and check in'));
  }

  async function doCheckin() {
    const spot = await readSpot(app, { why: 'This shows that you are at the place of the client.' });
    if (!spot) return;

    const bytes = await takeSelfie(app);
    if (!bytes) return;
    if (!rules.imageKind(bytes) || bytes.length > rules.MAX_BILL_BYTES) return toast('Please use a JPG, PNG or WebP picture under 5 MB.');

    if (selfieUrl) URL.revokeObjectURL(selfieUrl);
    selfieUrl = URL.createObjectURL(new Blob([bytes]));
    pending = { spot: { ...spot, at: new Date().toISOString() }, bytes };
    checkinSlot.setError(null);
    drawCheckin();
  }

  // ---- how did it go ------------------------------------------------------------------------------------------------------

  const answerSlot = slot(h('div', null, h('p', { class: 'eyebrow' }, 'How did it go?'), h('div', { class: 'how-tiles', role: 'radiogroup', 'aria-label': 'How did it go' })), null);
  const tiles = answerSlot.el.querySelector('.how-tiles');
  const moveBox = h('div', { class: 'stack' });
  const doneBox = h('div', { class: 'stack' });
  const moveSlot = slot(moveBox, null);

  function drawTiles() {
    tiles.replaceChildren(...[['done', 'Done', 'check'], ['missed', 'Missed', 'close'], ['move', 'Move', 'calendar']].map(([value, label, glyph]) => h('button', {
      type: 'button', class: 'how-tile', role: 'radio', 'aria-checked': String(state.answer === value),
      onclick() {
        state.answer = state.answer === value ? null : value;
        answerSlot.setError(null);
        drawCheckin();
        drawTiles();
        drawPanels();
      },
    }, icon(glyph, 20), label)));
  }

  const chips = whenChips(state, { onChange() { moveSlot.setError(null); drawClash(); } });
  const clashBox = h('div', null);

  function drawClash() {
    const clash = clashWith(store.meetings, state.when, m?.id);
    clashBox.replaceChildren(...(clash ? [h('div', { class: 'enq-warn', role: 'status' }, icon('alert', 18), h('p', { class: 'grow' }, `This overlaps with ${clash.client_name} at ${formatTime(timeOf(clash))}.`))] : []));
  }
  moveBox.append(chips.days, chips.times, clashBox);

  // ---- done: result, people, note, follow-up -------------------------------------------------------------------------------

  const resultBox = h('div', { class: 'chips', role: 'group', 'aria-label': 'Result' });
  const peopleBox = h('div', null);
  const noteInput = h('textarea', { class: 'input', maxLength: MAX_NOTE, rows: 3, placeholder: 'What was said, what they need next', 'aria-label': 'Note', value: state.note });
  const noteSlot = slot(h('div', null, h('p', { class: 'eyebrow' }, 'Note (optional)'), noteInput), noteInput);
  const followBox = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Follow up' });
  const followText = h('p', { class: 'muted small' });
  noteInput.addEventListener('input', () => { state.note = noteInput.value; });

  function drawResult() {
    resultBox.replaceChildren(...RESULTS.map((r) => h('button', {
      type: 'button', class: 'filter', 'aria-pressed': String(state.result === r.value),
      onclick() { state.result = state.result === r.value ? null : r.value; drawResult(); },
    }, r.label)));
  }

  function drawPeople() {
    const chosen = client();
    const list = chosen ? store.contactsOf(chosen.id) : [];
    for (const personId of [...state.met]) if (!list.some((p) => p.id === personId)) state.met.delete(personId);

    peopleBox.replaceChildren(...(chosen ? [
      h('p', { class: 'eyebrow' }, 'People you met (optional)'),
      h('div', { class: 'chips quick-picks', role: 'group', 'aria-label': 'People you met' },
        ...list.map((p) => h('button', {
          type: 'button', class: 'filter', 'aria-pressed': String(state.met.has(p.id)),
          onclick() {
            if (state.met.has(p.id)) state.met.delete(p.id);
            else state.met.add(p.id);
            drawPeople();
          },
        }, p.position ? `${p.name} · ${p.position}` : p.name)),
        h('button', {
          type: 'button', class: 'filter with-icon', 'aria-label': 'Add a person',
          onclick: () => openContactForm(app, { client: chosen, onSaved: (p) => { state.met.add(p.id); drawPeople(); } }),
        }, icon('plus', 15), 'Add')),
    ] : []));
  }

  const followDate = () => ({ tomorrow: tenAmIn(1), '3days': tenAmIn(3), week: tenAmIn(7), keep: m?.next_followup_at ? new Date(m.next_followup_at) : null })[state.follow] ?? null;

  function drawFollow() {
    const choices = [['tomorrow', 'Tomorrow'], ['3days', '3 days'], ['week', 'Next week']];
    if (m?.next_followup_at) choices.unshift(['keep', shortDay(new Date(m.next_followup_at))]);

    followBox.replaceChildren(...choices.map(([value, label]) => h('button', {
      type: 'button', class: 'filter', role: 'radio', 'aria-checked': String(state.follow === value),
      onclick() { state.follow = value; drawFollow(); },
    }, label)),
    h('button', { type: 'button', class: 'filter', role: 'radio', 'aria-checked': String(state.follow === 'none'), onclick() { state.follow = 'none'; drawFollow(); } }, 'No follow-up'));

    const at = followDate();
    followText.textContent = at ? `Reminder: ${shortDay(at)}, ${formatTime(at)}` : 'No reminder.';
  }

  const legacy = m?.outcome && !RESULTS.some((r) => r.value === m.outcome) ? h('p', { class: 'muted small' }, `Outcome noted before: ${m.outcome}`) : null;

  doneBox.append(
    h('div', null, h('p', { class: 'eyebrow' }, 'Result'), resultBox),
    peopleBox,
    noteSlot.el,
    h('div', null, h('p', { class: 'eyebrow' }, 'Follow up'), followBox, followText),
    ...(legacy ? [legacy] : []));

  function drawPanels() {
    moveSlot.el.hidden = state.answer !== 'move';
    doneBox.hidden = state.answer !== 'done';
    if (state.answer === 'move') {
      chips.redraw();
      drawClash();
    }
  }

  // ---- save ---------------------------------------------------------------------------------------------------------------

  const save = h('button', { class: 'btn primary block' }, 'Save visit');
  const alsoEnquiry = h('button', { type: 'button', class: 'link visit-enquiry' }, 'Also write an enquiry for this client');

  async function saveVisit() {
    const chosen = client();
    const typed = tidy(state.clientName);
    const logAt = log ? fromLocalInput(logWhen.value) : null;
    const planned = m ? timeOf(m) : null;

    const ok = validate([
      ...(log ? [
        [clientSlot, chosen || (state.other && !rules.businessName(typed, { label: 'Client name' })) ? null : state.other ? rules.businessName(typed, { label: 'Client name' }) : 'Choose a client, or type a new client name.'],
        [logSlot, logAt && !Number.isNaN(logAt.getTime()) ? loggedWindowProblem(logAt) : 'Pick the date and time.'],
      ] : [[answerSlot, state.answer ? null : 'Pick Done, Missed or Move.']]),
      [checkinSlot, state.answer === 'done' && !hasCheckin() && (!m || status !== 'done') ? 'Check in at the client first: take a selfie at the place.' : null],
      [noteSlot, state.answer === 'done' ? rules.optional(state.note, { max: MAX_NOTE, label: 'Note' }) : null],
      [moveSlot, state.answer === 'move' ? plannedWindowProblem(state.when) : null],
    ]);
    if (!ok) return null;

    const base = {
      id: m?.id,
      client_id: chosen?.id ?? null,
      client_name: chosen ? chosen.name : typed,
      contact_ids: state.answer === 'done' ? [...state.met] : m?.contact_ids ?? [],
      purpose: m?.purpose ?? '',
      outcome: m?.outcome ?? '',
      discussion: state.answer === 'done' ? state.note : m?.discussion ?? '',
      next_followup_at: state.answer === 'done' ? (followDate()?.toISOString() ?? null) : m?.next_followup_at ?? null,
      route_id: m?.route_id ?? null,
      ...(pending ? { checkin: pending.spot } : {}),
    };

    let input;
    if (state.answer === 'move') {
      const iso = state.when.toISOString();
      input = { ...base, status: 'moved', meeting_at: iso, scheduled_at: iso, moved_from: m.scheduled_at ?? m.meeting_at, time_manual: state.touched || m.time_manual === true, result: null };
    } else if (state.answer === 'missed') {
      input = { ...base, status: 'missed', meeting_at: planned.toISOString(), scheduled_at: planned.toISOString(), result: null };
    } else {
      // done: the moment it happened is now, or the planned time when that was earlier; a visit written again keeps its time
      const happened = log ? logAt : status === 'done' ? new Date(m.meeting_at) : new Date(Math.min(Date.now(), planned.getTime()));
      input = { ...base, status: 'done', meeting_at: happened.toISOString(), scheduled_at: log ? null : m.scheduled_at ?? (status === 'done' ? null : m.meeting_at), result: state.result };
    }

    save.disabled = true;
    try {
      return await store.saveMeeting(input, { selfie: pending?.bytes ?? null });
    } catch (error) {
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
      return null;
    } finally {
      save.disabled = false;
    }
  }

  async function finish(thenEnquiry) {
    const saved = await saveVisit();
    if (!saved) return;

    const route = saved.route_id ? store.routeById(saved.route_id) : null;
    const wasDone = state.answer === 'done';
    toast(state.answer === 'move' ? `Moved to ${shortDay(state.when)}, ${formatTime(state.when)}.` : state.answer === 'missed' ? 'Marked as missed.' : 'Visit saved.');
    page.close();

    if (thenEnquiry) openEnquiryForm(app, { preset: { client_id: saved.client_id } });
    else if (wasDone && route) await tripPrompt(app, route);
  }

  save.addEventListener('click', () => finish(false));
  alsoEnquiry.addEventListener('click', () => finish(true));

  const remove = m ? h('button', {
    type: 'button', class: 'link left sched-cancel',
    async onclick() {
      if (await confirmDialog({ title: 'Delete this meeting?', text: `Meeting with ${m.client_name} on ${shortDay(timeOf(m))}. It cannot be undone.` })) {
        await store.deleteMeeting(m.id);
        page.close();
      }
    },
  }, 'Delete meeting') : null;

  // the meeting can disappear while the page is open (the office, a sync): then there is nothing left to write
  const stop = store.subscribe(() => {
    if (m && !store.meetingById(m.id)) page?.close();
  });

  page = openPage({
    title: log ? 'Log a visit' : m.client_name,
    onClose() { stop(); if (selfieUrl) URL.revokeObjectURL(selfieUrl); },
    body: h('div', { class: 'stack sched' },
      top,
      ...(log ? [h('div', null, h('p', { class: 'eyebrow' }, 'Client'), clientSlot.el), logSlot.el] : [answerSlot.el]),
      checkinSlot.el,
      moveSlot.el,
      doneBox,
      remove),
    footer: h('div', { class: 'enq-foot' }, alsoEnquiry, save),
  });

  drawTop();
  drawClient();
  drawCheckin();
  drawTiles();
  drawResult();
  drawPeople();
  drawFollow();
  drawPanels();
  if (log) answerSlot.el.hidden = true;
}
