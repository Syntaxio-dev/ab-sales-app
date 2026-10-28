import { daysAgo, lastVisit, recentClients, searchClients } from '../core/enquiry.js';
import * as rules from '../core/rules.js';
import { h, icon } from './dom.js';
import { initials } from './format.js';
import { businessInput } from './inputs.js';
import { slot } from './kit.js';

// "Which client?": a search box and the rep's recent clients (from their enquiries and visits). Typing filters the pool by name or town; when
// nothing fits, the first row offers the typed text as a new client name (nothing is added to the pool from here). Used by the enquiry
// form and the meeting pages.
//
// `state` is the caller's own object: the picker reads and writes { clientId, other, clientName, search }. `onPick()` runs after the choice.

const lower = (text) => String(text ?? '').trim().toLowerCase();
const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function clientPicker(app, state, { onPick = () => {}, placeholder = 'Search client or city' } = {}) {
  const store = app.store;
  const clients = store.clients;
  const enquiries = store.enquiries;
  const meetings = store.meetings;

  const searchInput = businessInput({ placeholder, 'aria-label': 'Search clients', value: state.search ?? '' });
  const searchBox = h('div', { class: 'guide-search enq-search' }, icon('search', 20), searchInput);
  const listLabel = h('p', { class: 'eyebrow' });
  const rowsBox = h('div', { class: 'list', role: 'radiogroup', 'aria-label': 'Client' });
  const listSlot = slot(h('div', null, listLabel, rowsBox), searchInput);

  const pickRow = (selected, avatar, title, sub, onclick) => h('button', {
    type: 'button', class: 'item pick', role: 'radio', 'aria-checked': String(selected), onclick,
  },
  h('span', { class: 'avatar' }, avatar),
  h('span', { class: 'grow' }, h('span', { class: 'title' }, title), sub ? h('span', { class: 'sub' }, sub) : null),
  selected ? h('span', { class: 'tick' }, icon('check', 15)) : null);

  const clientRow = (c) => {
    const visit = lastVisit(meetings, c.id);
    const sub = [c.city, visit ? `last visit ${daysAgo(visit)}` : null].filter(Boolean).join(' · ');
    return pickRow(state.clientId === c.id, initials(c.name), c.name, sub, () => pickClient(c.id));
  };

  const newClientRow = (name, selected) => pickRow(selected, initials(name), selected ? name : `Add "${name}" as a new client name`, selected ? 'New client name, not saved in the client list' : null, () => pickNew(name));

  function pickClient(id) {
    Object.assign(state, { clientId: id, other: false, clientName: '' });
    listSlot.setError(null);
    draw();
    onPick('client');
  }

  function pickNew(name) {
    Object.assign(state, { clientId: null, other: true, clientName: tidy(name) });
    listSlot.setError(null);
    draw();
    onPick('new');
  }

  function draw() {
    const text = tidy(state.search);
    const rows = [];

    if (state.other && state.clientName) rows.push(newClientRow(state.clientName, true));

    if (text) {
      const found = searchClients(clients, text);
      const exact = found.some((c) => lower(c.name) === lower(text));
      const chosenAlready = state.other && lower(state.clientName) === lower(text);
      const add = rules.businessName(text, { label: 'Client name' }) || chosenAlready ? null : newClientRow(text, false);

      if (!found.length) rows.push(add);
      else rows.push(...found.map(clientRow), exact ? null : add);
      listLabel.textContent = found.length ? 'Matches' : 'No client found';
    } else {
      const list = recentClients({ enquiries, meetings, clients }).map((r) => r.client);
      const chosen = state.clientId ? store.clientById(state.clientId) : null;
      if (chosen && !list.some((c) => c.id === chosen.id)) list.unshift(chosen);
      rows.push(...list.map(clientRow));
      listLabel.textContent = list.length ? 'Recent clients' : '';
      if (!list.length && !rows.length) rows.push(h('p', { class: 'muted small' }, clients.length ? 'Type a name above to find a client.' : 'No clients yet. Type the name above to add one.'));
    }

    listLabel.hidden = !listLabel.textContent;
    rowsBox.replaceChildren(...rows.filter(Boolean));
  }

  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    draw();
  });

  draw();
  return { searchBox, slot: listSlot, draw, reset() { searchInput.value = ''; state.search = ''; draw(); } };
}
