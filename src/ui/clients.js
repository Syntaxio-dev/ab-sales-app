import { h, icon } from './dom.js';
import { openClientForm, openMeetingForm } from './forms.js';
import { capitalize, formatDay, formatDayTime, initials } from './format.js';
import { openPage } from './kit.js';
import { callButton, openContactForm } from './people.js';

// One client of the shared pool: who is at it (name, position, number) with a call button, the calls and meetings with it,
// and who works it. Redraws by itself when the data changes (a sync, an edit), and stops when the page closes.

const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function callLabel(call) {
  return `${capitalize(call.direction)}${call.direction === 'missed' || !call.duration_seconds ? '' : ` ${mmss(call.duration_seconds)}`}`;
}

export function openClientPage(app, clientId) {
  const store = app.store;
  const body = h('div', { class: 'stack' });
  let page = null;

  const line = (key, value) => (value ? h('div', { class: 'detail-line' }, h('span', { class: 'k' }, key), h('span', { class: 'v' }, value)) : null);

  const draw = () => {
    const client = store.clientById(clientId);
    if (!client) { // deleted meanwhile (by the office or its owner)
      page?.close();
      return;
    }

    const people = store.contactsOf(clientId);
    const calls = store.callsOf(clientId).slice(0, 6);
    const meetings = store.meetings.filter((m) => m.client_id === clientId).slice(0, 5);
    const mine = client.assigned_to_code && client.assigned_to_code === store.profile?.employee_code;

    const parts = [
      h('div', { class: 'card pad' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('span', { class: 'avatar' }, initials(client.name)),
          h('div', { class: 'grow', style: { minWidth: '0' } }, h('h2', { style: { fontSize: '19px' } }, client.name), client.city ? h('p', { class: 'muted' }, client.city) : null),
          client.phone ? callButton(client.phone) : null),
        h('div', { style: { marginTop: '10px' } },
          line('Works with', client.assigned_to_name ? `${client.assigned_to_name}${mine ? ' (you)' : ''}` : 'Nobody yet'),
          line('Main number', client.phone),
          line('Group', client.company),
          line('Added by', client.created_by_name),
          line('Notes', client.notes)),
        h('button', { class: 'btn small-btn block', style: { marginTop: '10px' }, onclick: () => openClientForm(app, client) }, icon('edit', 18), 'Edit client')),

      h('div', null,
        h('div', { class: 'section-head', style: { marginBottom: '10px' } }, h('p', { class: 'eyebrow' }, `People (${people.length})`),
          h('button', { class: 'link', onclick: () => openContactForm(app, { client }) }, '+ Add a person')),
        people.length
          ? h('div', { class: 'list' }, people.map((p) => h('div', { class: 'item', role: 'button', tabindex: '0', onclick: () => openContactForm(app, { client, existing: p }) },
            h('span', { class: 'avatar' }, initials(p.name)),
            h('span', { class: 'grow' },
              h('span', { class: 'title' }, p.name),
              h('span', { class: 'sub' }, [p.position, p.phone].filter(Boolean).join(' · ') || 'No position or number yet')),
            p.phone ? h('span', { class: 'item-actions' }, callButton(p.phone, `Call ${p.name}`)) : null)))
          : h('div', { class: 'card pad muted' }, 'Nobody is saved here yet. Add the people you can call: their calls are then matched by number.')),

      calls.length ? h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Recent calls'),
        h('div', { class: 'list' }, calls.map((c) => h('div', { class: 'item', style: { minHeight: '56px' } },
          h('span', { class: 'grow' },
            h('span', { class: 'title' }, c.contact_name || c.client_name),
            h('span', { class: 'sub' }, formatDayTime(new Date(c.started_at)))),
          h('span', { class: 'end' }, h('span', { class: `chip ${c.direction}` }, callLabel(c))))))) : null,

      h('div', null,
        h('div', { class: 'section-head', style: { marginBottom: '10px' } }, h('p', { class: 'eyebrow' }, 'Meetings'),
          h('button', { class: 'link', onclick: () => openMeetingForm(app, null, { client_id: clientId }) }, '+ New meeting')),
        meetings.length
          ? h('div', { class: 'list' }, meetings.map((m) => h('button', { class: 'item', onclick: () => openMeetingForm(app, m) },
            h('span', { class: 'grow' },
              h('span', { class: 'title' }, formatDay(new Date(m.meeting_at))),
              h('span', { class: 'sub' }, m.purpose || m.outcome || 'No purpose written')))))
          : h('div', { class: 'card pad muted' }, 'No meetings with this client yet.')),
    ];

    body.replaceChildren(...parts.filter(Boolean));
  };

  const stop = store.subscribe(draw);
  draw();

  page = openPage({ title: store.clientById(clientId)?.name ?? 'Client', body, onClose: stop });
}
