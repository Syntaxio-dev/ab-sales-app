import { suggestedReminder } from '../core/lead.js';
import * as pr from '../core/prospect.js';
import * as rules from '../core/rules.js';
import { normalizePhone } from '../core/phone.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { formatDayTime, fromLocalInput, initials, tenAmIn, toLocalInput } from './format.js';
import { openClientForm } from './forms.js';
import { businessInput, cityPicks, emailInput, personInput, phoneField, placeInput, restrict } from './inputs.js';
import { chipGroup, confirmDialog, field, openPage, toast, validate } from './kit.js';
import { empty, fill, head } from './parts.js';
import { callButton, openContactForm, positionField } from './people.js';
import { dateTimeInput } from './pickers.js';

// Prospecting (v1.19): companies that do not work with us yet, found online or on the road, kept for cold calling by territory. It lives
// inside the Clients tab (a switch under the title). One pool for the whole team: everybody reads it, anybody can log a call, only the rep
// who added a prospect changes its details (the same rule as the client pool).

// ---- what the Clients tab remembers while the app is open --------------------------------------------------------------

let mode = 'clients'; // 'clients' | 'prospects': the switch under the title
let scope = null;     // 'mine' | 'all'; null = "mine" once the rep has chosen territories, otherwise "all"
let area = '';        // one territory the list is narrowed to
let query = '';

export const prospectMode = () => mode === 'prospects';

export function resetProspectView() {
  mode = 'clients';
  scope = null;
  area = '';
  query = '';
}

// The switch under the Clients title. `onSwitch` draws the tab again.
export function modeSwitch(onSwitch) {
  return h('div', { class: 'seg two', role: 'radiogroup', 'aria-label': 'Clients or prospects' },
    ...[['clients', 'Clients'], ['prospects', 'Prospects']].map(([value, label]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(value === mode),
      onclick() {
        if (mode === value) return;
        mode = value;
        onSwitch();
      },
    }, label)));
}

const myAreas = (store) => pr.cleanAreas(store.prefs.prospect_areas);

const line = (key, value) => (value ? h('div', { class: 'detail-line' }, h('span', { class: 'k' }, key), h('span', { class: 'v' }, value)) : null);

const isDue = (status, now = Date.now()) => pr.isOpenProspect(status) && Boolean(status.note?.next_followup_at) && Date.parse(status.note.next_followup_at) <= now;

// due follow-ups first, then companies nobody has called, then the ones being worked, closed ones last
const rankOf = (status, now) => (isDue(status, now) ? 0 : status.outcome === 'new' ? 1 : pr.isOpenProspect(status) ? 2 : 3);

// ---- the list (the Prospects side of the Clients tab) ----------------------------------------------------------------------

export function renderProspects(container, app, ctx, redraw) {
  const store = app.store;
  const all = store.prospects;
  const areas = myAreas(store);
  const team = pr.territories(all);
  const statuses = store.prospectStatuses();
  const now = Date.now();

  const effective = scope ?? (areas.length ? 'mine' : 'all');
  const choices = effective === 'mine' ? areas : team.map((t) => t.name);
  if (area && !choices.some((name) => pr.territoryKey(name) === pr.territoryKey(area))) area = '';

  const list = h('div', { class: 'client-list' });
  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Territories' });
  const countOf = (name) => team.find((t) => pr.territoryKey(t.name) === pr.territoryKey(name))?.count ?? 0;

  const row = (p) => {
    const status = statuses.get(p.id);
    const due = isDue(status, now);
    return h('button', { class: 'item', onclick: () => openProspectPage(app, p.id) },
      h('span', { class: 'avatar' }, initials(p.name)),
      h('span', { class: 'grow' },
        h('span', { class: 'title' }, p.name),
        h('span', { class: 'sub' }, [p.territory, p.people.length ? `${p.people.length} ${p.people.length === 1 ? 'person' : 'people'}` : 'No people yet', pr.lastCallLine(status, now)].join(' · ')),
        h('span', { class: 'sub added' }, `Added by ${store.addedBy(p)}`)),
      due ? h('span', { class: 'end' }, h('span', { class: 'chip' }, 'Call due')) : null);
  };

  const draw = () => {
    const chip = (label, pressed, onclick) => h('button', { class: 'filter', type: 'button', 'aria-pressed': String(pressed), onclick }, label);

    filters.replaceChildren(
      chip(areas.length ? `My territories (${areas.length})` : 'My territories', effective === 'mine', () => { scope = 'mine'; area = ''; redraw(); }),
      chip('All territories', effective === 'all', () => { scope = 'all'; area = ''; redraw(); }),
      ...choices.map((name) => chip(`${name} (${countOf(name)})`, pr.territoryKey(name) === pr.territoryKey(area), () => {
        area = pr.territoryKey(name) === pr.territoryKey(area) ? '' : name;
        draw();
      })));

    const needsAreas = effective === 'mine' && !areas.length;
    const shown = needsAreas ? [] : all
      .filter((p) => (effective === 'all' || pr.inAreas(p, areas))
        && (!area || pr.territoryKey(p.territory) === pr.territoryKey(area))
        && pr.matches(p, query))
      .sort((a, b) => rankOf(statuses.get(a.id), now) - rankOf(statuses.get(b.id), now) || a.name.localeCompare(b.name));

    if (needsAreas) {
      list.replaceChildren(empty('pin', 'Choose your territories', 'Pick the areas you work in, for example Bagru or Behror. Your list then shows the companies there.'),
        h('button', { class: 'btn primary block', onclick: () => openTerritories(app) }, 'Choose my territories'));
    } else if (!shown.length) {
      list.replaceChildren(all.length
        ? empty('search', 'Nothing found', query || area ? 'Try another name, number or territory.' : 'No prospects in your territories yet. Add the first one.')
        : empty('users', 'No prospects yet', 'Add a company that does not work with us yet, with the people you can call there. Everybody on the team sees it, so nobody calls the same company twice.'));
    } else {
      list.replaceChildren(h('div', { class: 'list' }, shown.map(row)));
    }
  };

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search company, person, number or area', autocomplete: 'off', value: query, 'aria-label': 'Search prospects' });
  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });

  draw();
  fill(container,
    head({ eyebrow: `${all.length} ${all.length === 1 ? 'prospect' : 'prospects'}`, title: 'Clients' }),
    h('div', { class: 'client-tools' },
      modeSwitch(redraw),
      filters,
      h('div', { class: 'section-head' }, h('button', { class: 'link', onclick: () => openTerritories(app) }, 'Choose my territories')),
      search),
    list);
  ctx.fab('Add prospect', () => openProspectForm(app, null, { territory: area || (areas.length === 1 ? areas[0] : '') }));
}

// ---- one prospect -----------------------------------------------------------------------------------------------------------

export function openProspectPage(app, id) {
  const store = app.store;
  const body = h('div', { class: 'stack' });
  let page = null;

  const draw = () => {
    const p = store.prospectById(id);
    if (!p) { // deleted meanwhile (by the rep who added it, or the office)
      page?.close();
      return;
    }

    const status = store.prospectStatus(id);
    const notes = store.notesOf(id);
    const own = store.canEdit(p);
    const due = isDue(status);

    const personRow = (person, i) => h('div', { class: 'item prospect-person', ...(own ? { role: 'button', tabindex: '0', onclick: () => openProspectPerson(app, id, i) } : {}) },
      h('span', { class: 'avatar' }, initials(person.name)),
      h('span', { class: 'grow' },
        h('span', { class: 'title' }, person.name),
        person.position ? h('span', { class: 'sub' }, person.position) : null,
        person.phone ? h('span', { class: 'sub' }, person.phone) : null,
        person.email ? h('a', { class: 'link sub', href: `mailto:${person.email}`, onclick: (event) => event.stopPropagation() }, person.email) : null,
        // only a clean linkedin.com address is ever stored (core/prospect.js), so this link cannot lead anywhere else
        person.linkedin ? h('a', { class: 'link sub', href: person.linkedin, target: '_blank', rel: 'noopener noreferrer', onclick: (event) => event.stopPropagation() }, 'LinkedIn profile') : null),
      person.phone ? h('span', { class: 'item-actions' }, callButton(person.phone, `Call ${person.name}`)) : null);

    const noteRow = (n) => h('div', { class: 'item', style: { minHeight: '56px' } },
      h('span', { class: 'grow' },
        h('span', { class: 'title' }, pr.outcomeLabel(n.outcome)),
        n.remark ? h('span', { class: 'sub' }, n.remark) : null,
        h('span', { class: 'sub added' }, `${store.addedBy(n)} · ${formatDayTime(new Date(n.created_at))}`),
        n.next_followup_at && n === notes[0] && pr.isOpenProspect(status) ? h('span', { class: 'sub' }, `Call again: ${formatDayTime(new Date(n.next_followup_at))}`) : null));

    body.replaceChildren(...[
      h('div', { class: 'card pad' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('span', { class: 'avatar' }, initials(p.name)),
          h('div', { class: 'grow', style: { minWidth: '0' } }, h('h2', { style: { fontSize: '19px' } }, p.name), h('p', { class: 'muted' }, p.territory))),
        h('div', { style: { marginTop: '10px' } },
          h('div', { class: 'detail-line' }, h('span', { class: 'k' }, 'Status'), h('span', { class: 'v' }, h('span', { class: 'chip' }, due ? `${status.label} · call due` : status.label))),
          line('Address', p.address),
          line('Found through', pr.sourceLabel(p.source)),
          line('Added by', store.addedBy(p)),
          line('Notes', p.notes)),
        h('div', { class: 'stack', style: { marginTop: '12px' } },
          h('button', { class: 'btn primary block', onclick: () => openCallNote(app, p) }, icon('phone', 18), 'Log a call'),
          pr.isOpenProspect(status) || status.outcome === 'not_interested' ? h('button', { class: 'btn block', onclick: () => convert(app, p) }, icon('userplus', 18), 'Make this a client') : null,
          own ? h('button', { class: 'btn small-btn block', onclick: () => openProspectForm(app, p) }, icon('edit', 18), 'Edit details') : h('p', { class: 'muted small' }, 'Only the rep who added this prospect can change its details. You can log your own calls and add it as a client.'))),

      h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, `People (${p.people.length})`),
        p.people.length ? h('div', { class: 'list' }, p.people.map(personRow)) : h('div', { class: 'card pad muted' }, own ? 'No one is saved here yet. Add the people you can call.' : 'No one is saved here yet.'),
        own ? h('button', { class: 'btn block', style: { marginTop: '10px' }, onclick: () => openProspectPerson(app, id) }, icon('userplus', 18), 'Add contact person') : null),

      h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, `Calls (${notes.length})`),
        notes.length ? h('div', { class: 'list' }, notes.map(noteRow)) : h('div', { class: 'card pad muted' }, 'Nobody has called yet. After a call, tap "Log a call" so the team knows.')),
    ].filter(Boolean));
  };

  const stop = store.subscribe(draw);
  draw();
  page = openPage({ title: store.prospectById(id)?.name ?? 'Prospect', body, onClose: stop });
}

// A prospect becomes a client: the client form opens with what we know, then the people are added one by one, and the call log says so.
async function convert(app, p) {
  const store = app.store;
  const people = p.people.filter((x) => x.name);
  const first = people.find((x) => x.phone);

  openClientForm(app, null, {
    prefill: { name: p.name, city: p.territory, phone: '' },
    async onSaved(client) {
      try {
        await store.saveProspectNote({ prospect_id: p.id, outcome: 'converted', remark: `Became a client: ${client.name}` });
      } catch {
        toast('The client was saved, but the prospect could not be marked.');
      }

      // the people come along, one form after the other (each can be skipped by going back)
      const next = (i) => {
        if (i >= people.length) return;
        openContactForm(app, { client, prefill: people[i], onSaved: () => next(i + 1) });
      };
      if (people.length) next(0);
      else openContactForm(app, { client, number: first?.phone ?? '' });
    },
  });
}

// ---- log a call ---------------------------------------------------------------------------------------------------------------

// What the follow-up suggests after each outcome (the same times the Leads follow-up uses), or none.
const SUGGEST = { no_answer: 'call_not_picking', call_back: 'new', interested: 'interested' };
const TWO_YEARS = 2 * 365 * 86_400_000;
const inHours = (n) => new Date(Date.now() + n * 3_600_000);

export function openCallNote(app, prospect) {
  const store = app.store;
  const state = { outcome: null, next: null, touched: false };

  const outcome = (() => {
    const group = chipGroup(pr.OUTCOMES.map((o) => ({ value: o.value, label: o.label })).filter((o) => o.value !== 'converted'), null, (value) => {
      state.outcome = value;
      if (!state.touched) state.next = SUGGEST[value] ? suggestedReminder(SUGGEST[value]) : null;
      drawNext();
    });
    return { group, ...field('What happened on the call?', group.el) };
  })();

  const remark = restrict(h('textarea', { class: 'input', rows: 3, maxLength: pr.MAX_REMARK, 'aria-label': 'Remark', placeholder: 'What did they say? For example: send the catalogue on WhatsApp, call after Diwali' }), /[<>;]/g, { collapse: false });
  const remarkSlot = field('Remark (optional)', remark);

  const pick = dateTimeInput({ min: toLocalInput(new Date()), max: toLocalInput(new Date(Date.now() + TWO_YEARS - 86_400_000)), placeholder: 'Pick date and time', pickerTitle: 'Call again', 'aria-label': 'Call again' });
  pick.addEventListener('change', () => {
    const at = fromLocalInput(pick.value);
    if (!at) return;
    state.next = at;
    state.touched = true;
    drawNext();
  });

  const nextLine = h('p', { class: 'lead-when' });
  const nextChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Call again' });
  const nextBox = h('div', { class: 'stack' });
  const nextSlot = field('Call again', nextBox, 'Shown on the prospect and first in the list when it is due.');

  function drawNext() {
    const closed = state.outcome && !(pr.OUTCOMES.find((o) => o.value === state.outcome)?.open);
    nextSlot.el.hidden = !state.outcome || Boolean(closed);
    if (nextSlot.el.hidden) return;

    const same = (a, b) => a && b && Math.abs(a.getTime() - b.getTime()) < 60_000;
    const set = (at) => { state.next = at; state.touched = true; drawNext(); };
    const choices = [['In 3 hours', inHours(3)], ['Tomorrow 10 am', tenAmIn(1)], ['In 3 days', tenAmIn(3)], ['Next week', tenAmIn(7)]];

    nextChips.replaceChildren(
      ...choices.map(([label, at]) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(Boolean(same(state.next, at))), onclick: () => set(at) }, label)),
      h('button', { type: 'button', class: 'filter', 'aria-pressed': String(state.touched && !state.next), onclick: () => set(null) }, 'No follow-up'));
    nextLine.replaceChildren(icon('alarm', 16), state.next ? ` ${formatDayTime(state.next)}` : ' No follow-up planned.');
    nextBox.replaceChildren(nextLine, nextChips, pick);
  }
  drawNext();

  let page = null;
  const save = h('button', { class: 'btn primary block' }, 'Save call');
  save.addEventListener('click', async () => {
    if (!validate([[outcome, state.outcome ? null : 'Pick what happened on the call.'], [remarkSlot, rules.optional(remark.value, { max: pr.MAX_REMARK, label: 'Remark' })]])) return;

    if (state.outcome === 'do_not_call' && !(await confirmDialog({ title: 'Mark as do not call?', text: 'The whole team will see that this company must not be called.', yes: 'Yes, do not call', danger: false }))) return;

    save.disabled = true;
    try {
      await store.saveProspectNote({ prospect_id: prospect.id, outcome: state.outcome, remark: remark.value, next_followup_at: state.next ? state.next.toISOString() : null });
      toast('Call saved.');
      page?.close();
    } catch (error) {
      save.disabled = false;
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    }
  });

  const first = prospect.people.find((x) => x.phone);
  page = openPage({
    title: 'Log a call',
    body: h('div', { class: 'stack' },
      h('div', { class: 'card pad' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('span', { class: 'avatar' }, initials(prospect.name)),
          h('div', { class: 'grow', style: { minWidth: '0' } }, h('h2', { style: { fontSize: '19px' } }, prospect.name), h('p', { class: 'muted small' }, prospect.territory)),
          first ? callButton(first.phone, `Call ${first.name}`) : null)),
      outcome.el, remarkSlot.el, nextSlot.el),
    footer: save,
  });
}

// ---- add / edit a prospect ------------------------------------------------------------------------------------------------------

// One person of the form: a small card with its own boxes. Everything is optional except the name, and a card left empty is ignored.
function personCard(app, initial, onRemove) {
  const name = field('Name', personInput({ value: initial.name ?? '' }));
  const position = positionField(app, initial.position ?? '');
  const phone = phoneField('Phone number (optional)', { value: initial.phone ?? '', landline: true, hint: 'A mobile or an office number with its area code.' });
  const email = field('E-mail (optional)', emailInput({ value: initial.email ?? '' }));
  const linkedin = field('LinkedIn (optional)', restrict(h('input', {
    class: 'input', type: 'text', inputMode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, maxLength: 300, placeholder: 'linkedin.com/in/name', value: initial.linkedin ?? '',
  }), /[\s<>"'\\]/g, { collapse: false }), 'Paste the profile or company page link.');

  const title = h('p', { class: 'eyebrow' }, 'Person');
  const el = h('div', { class: 'card pad stack person-card' },
    h('div', { class: 'section-head' }, title, onRemove ? h('button', { type: 'button', class: 'link', onclick: onRemove }, 'Remove') : null),
    name.el, position.el, phone.el, email.el, linkedin.el);

  return {
    el, name, position, phone, email, linkedin,
    setTitle: (text) => { title.textContent = text; },
    isEmpty: () => !name.input.value.trim() && !position.value && !phone.value && !email.input.value.trim() && !linkedin.input.value.trim(),
    value: () => ({ name: name.input.value, position: position.value, phone: phone.value, email: email.input.value, linkedin: linkedin.input.value }),
  };
}

export function openProspectForm(app, existing = null, { territory = '' } = {}) {
  const store = app.store;
  if (existing && !store.canEdit(existing)) {
    toast(`Added by ${store.addedBy(existing)}. Only they can change the details. You can log your own calls.`);
    return;
  }

  const company = field('Company', businessInput({ placeholder: 'For example Bagru Textiles', value: existing?.name ?? '' }), 'A company that does not work with us yet.');
  const place = field('Territory', placeInput({ placeholder: 'Town or area, for example Bagru', value: existing?.territory ?? territory }), 'Required. The team sorts prospects by territory.');
  const known = [...pr.territories(store.prospects).map((t) => t.name), ...myAreas(store), ...pr.SUGGESTED_TERRITORIES];
  const picks = [...new Map(known.map((name) => [pr.territoryKey(name), name])).values()].slice(0, 16);
  place.input.after(cityPicks(place.input, picks, 'Quick picks for the territory'));

  const address = field('Address or landmark (optional)', businessInput({ maxLength: pr.MAX_ADDRESS, placeholder: 'Plot, road, industrial area', value: existing?.address ?? '' }));
  const source = chipGroup([{ value: null, label: 'Not sure' }, ...pr.SOURCES], existing?.source ?? null);
  const sourceSlot = field('Where did you find it? (optional)', source.el);
  const notes = field('Notes (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_NOTE, rows: 3, value: existing?.notes ?? '' }));

  // the people: at least one card to start with
  const cards = [];
  const box = h('div', { class: 'stack' });
  const add = h('button', { type: 'button', class: 'btn block', onclick: () => addCard({}) }, icon('plus', 18), 'Add another person');

  function addCard(initial) {
    const card = personCard(app, initial, () => {
      cards.splice(cards.indexOf(card), 1);
      drawCards();
    });
    cards.push(card);
    drawCards();
  }

  function drawCards() {
    cards.forEach((card, i) => card.setTitle(cards.length > 1 ? `Person ${i + 1}` : 'Person at the company'));
    box.replaceChildren(...cards.map((card) => card.el));
    add.hidden = cards.length >= pr.MAX_PEOPLE;
  }

  for (const person of existing?.people?.length ? existing.people : [{}]) addCard(person);

  const save = h('button', { class: 'btn primary block' }, 'Save prospect');
  save.addEventListener('click', async () => {
    const used = cards.filter((card) => !card.isEmpty());
    const seen = new Set();

    const checks = [
      [company, rules.businessName(company.input.value, { label: 'Company' })],
      [place, pr.territoryProblem(place.input.value)],
      [address, rules.optional(address.input.value, { max: pr.MAX_ADDRESS, label: 'Address' })],
      [notes, rules.optional(notes.input.value, { max: rules.MAX_NOTE, label: 'Notes' })],
    ];
    for (const card of cards) {
      for (const f of [card.name, card.position, card.phone, card.email, card.linkedin]) f.setError?.(null);
    }
    for (const card of used) {
      const value = card.value();
      const normal = normalizePhone(value.phone) ?? '';
      const taken = normal ? store.prospectNumberOwner(normal, { exceptProspect: existing?.id }) : null;
      const twice = normal && seen.has(normal);
      if (normal) seen.add(normal);

      checks.push(
        [card.name, rules.personName(value.name, { label: 'Name', max: 150 })],
        [card.phone, card.phone.problem() ?? (twice ? 'Another person here has this number.' : taken ? `This number is already saved under ${taken}.` : null)],
        [card.email, rules.email(value.email)],
        [card.linkedin, pr.linkedinProblem(value.linkedin)]);
    }
    if (!validate(checks)) return;

    save.disabled = true;
    try {
      const saved = await store.saveProspect({
        id: existing?.id, name: company.input.value, territory: place.input.value, address: address.input.value, source: source.value, notes: notes.input.value,
        people: used.map((card) => card.value()),
      });
      toast('Prospect saved.');
      page.close();
      if (!existing) openProspectPage(app, saved.id); // straight on to the first call
    } catch (error) {
      save.disabled = false;
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    }
  });

  const page = openPage({
    title: existing ? 'Edit prospect' : 'New prospect',
    body: h('div', { class: 'stack' },
      company.el, place.el, address.el, sourceSlot.el,
      h('p', { class: 'eyebrow' }, 'People you can call'), box, add,
      notes.el,
      existing ? h('p', { class: 'muted small' }, `Added by ${store.addedBy(existing)}.`) : null,
      existing && store.canDelete(existing) ? h('button', {
        class: 'btn danger block',
        async onclick() {
          if (await confirmDialog({ title: `Delete ${existing.name}?`, text: 'The prospect and its calls leave the pool for the whole team. This cannot be undone.' })) {
            try {
              await store.deleteProspect(existing.id);
              page.close();
            } catch (error) {
              toast(error instanceof ValidationError ? error.message : 'Could not delete.');
            }
          }
        },
      }, icon('trash', 18), 'Delete prospect') : null),
    footer: save,
  });
}

// ---- my territories ------------------------------------------------------------------------------------------------------------------

// The rep's own list of territories (kept on this phone). The list of prospects shows only these, unless the rep looks at all of them.
export function openTerritories(app) {
  const store = app.store;
  const listBox = h('div', { class: 'stack' });
  let page = null;

  const save = (list) => store.savePrefs({ prospect_areas: pr.cleanAreas(list) });
  const namesNow = () => {
    const mine = myAreas(store);
    const team = pr.territories(store.prospects);
    return { mine, team, names: [...team.map((t) => t.name), ...mine.filter((m) => !team.some((t) => pr.territoryKey(t.name) === pr.territoryKey(m)))] };
  };

  // the list redraws when the data changes; the "add" boxes below it are built once, so a sync never wipes what is being typed
  const draw = () => {
    const { mine, team, names } = namesNow();
    const on = (name) => mine.some((m) => pr.territoryKey(m) === pr.territoryKey(name));

    listBox.replaceChildren(names.length
      ? h('div', { class: 'list' }, names.map((name) => h('button', {
        class: 'item', type: 'button', 'aria-pressed': String(on(name)),
        async onclick() {
          await save(on(name) ? mine.filter((m) => pr.territoryKey(m) !== pr.territoryKey(name)) : [...mine, name]);
        },
      },
      h('span', { class: 'grow' }, h('span', { class: 'title' }, name), h('span', { class: 'sub' }, `${team.find((t) => pr.territoryKey(t.name) === pr.territoryKey(name))?.count ?? 0} prospects`)),
      h('span', { class: 'end' }, on(name) ? h('span', { class: 'chip approved' }, 'Mine') : h('span', { class: 'chip' }, 'Add')))))
      : h('div', { class: 'card pad muted' }, 'No territory yet. Add the first one below.'));
  };

  const add = placeInput({ placeholder: 'Another area, for example Behror', 'aria-label': 'New territory' });
  const addSlot = field('Add a territory', add, 'It joins the list for the whole team once someone saves a prospect there.');
  // suggestions only for places that are not on the list yet
  const listed = namesNow().names;
  const suggested = pr.SUGGESTED_TERRITORIES.filter((n) => !listed.some((x) => pr.territoryKey(x) === pr.territoryKey(n)));
  const addChips = suggested.length ? cityPicks(add, suggested, 'Suggested territories') : null;
  const submit = h('button', { class: 'btn block', type: 'button' }, icon('plus', 18), 'Add to my territories');
  submit.addEventListener('click', async () => {
    const problem = pr.territoryProblem(add.value);
    addSlot.setError(problem);
    if (problem) return;

    const { mine, names } = namesNow();
    await save([...mine, pr.canonicalTerritory(add.value, names)]);
    add.value = '';
    add.dispatchEvent(new Event('input', { bubbles: true }));
    toast('Territory added.');
  });

  const stop = store.subscribe(draw);
  draw();
  page = openPage({
    title: 'My territories',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Tap the areas you work in. Your Prospects list then shows the companies there. You can always look at all territories.'),
      listBox, addSlot.el, addChips, submit),
    onClose: stop,
  });
  return page;
}

// ---- add / edit one person of a prospect ---------------------------------------------------------------------------------------------

// A company often has two or three people to call (the purchase head, the lab head ...): this page adds ONE person to a prospect that is
// already saved, with "Save and add another" for the next one. Only the rep who added the prospect does this (the people are part of its
// details). `index` = the person to change (null = a new one).
export function openProspectPerson(app, prospectId, index = null) {
  const store = app.store;
  const prospect = store.prospectById(prospectId);
  if (!prospect || !store.canEdit(prospect)) return;

  const editing = index !== null && prospect.people[index] ? prospect.people[index] : null;
  const card = personCard(app, editing ?? {}, null);
  let page = null;

  const saveList = (people) => store.saveProspect({
    id: prospect.id, name: prospect.name, territory: prospect.territory, address: prospect.address, source: prospect.source, notes: prospect.notes, people,
  });

  async function submit(button, again) {
    const value = card.value();
    const normal = normalizePhone(value.phone) ?? '';
    const taken = normal ? store.prospectNumberOwner(normal, { exceptProspect: prospect.id }) : null;
    const same = normal && prospect.people.some((x, i) => i !== index && x.phone === normal);

    const ok = validate([
      [card.name, rules.personName(value.name, { label: 'Name', max: 150 })],
      [card.phone, card.phone.problem() ?? (same ? 'This number is already saved for another person here.' : taken ? 'This number is already saved under ' + taken + '.' : null)],
      [card.email, rules.email(value.email)],
      [card.linkedin, pr.linkedinProblem(value.linkedin)],
    ]);
    if (!ok) return;

    button.disabled = true;
    try {
      await saveList(editing ? prospect.people.map((x, i) => (i === index ? value : x)) : [...prospect.people, value]);
      toast(editing ? 'Person saved.' : 'Person added.');
      page.close();
      if (again) openProspectPerson(app, prospectId);
    } catch (error) {
      button.disabled = false;
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    }
  }

  const save = h('button', { class: 'btn primary block' }, editing ? 'Save person' : 'Add person');
  save.addEventListener('click', () => submit(save, false));
  const saveMore = editing ? null : h('button', { class: 'btn block' }, icon('plus', 18), 'Save and add another');
  saveMore?.addEventListener('click', () => submit(saveMore, true));

  page = openPage({
    title: editing ? 'Edit person' : 'Add contact person',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'At ' + prospect.name + ', ' + prospect.territory + '. Add everybody you can call there.'),
      card.el,
      editing ? h('button', {
        class: 'btn danger block',
        async onclick() {
          if (await confirmDialog({ title: 'Remove ' + editing.name + '?', text: 'The person is removed from this prospect for the whole team.' })) {
            try {
              await saveList(prospect.people.filter((x, i) => i !== index));
              page.close();
            } catch (error) {
              toast(error instanceof ValidationError ? error.message : 'Could not remove.');
            }
          }
        },
      }, icon('trash', 18), 'Remove this person') : null),
    footer: h('div', { class: 'stack' }, save, saveMore),
  });
}
