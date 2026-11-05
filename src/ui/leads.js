import { budgetTotal, daysAgo, isOpen, itemsSummary, openEnquiriesOf } from '../core/enquiry.js';
import { LEAD_VIEWS, byRecent, filterLeads, leadCounts, leadLabel, matches } from '../core/lead.js';
import { h, icon } from './dom.js';
import { followupChip, openEnquiryPage } from './enquiries.js';
import { openEnquiryForm } from './enquiry-form.js';
import { clientPicker } from './client-picker.js';
import { initials, rupees } from './format.js';
import { openPage } from './kit.js';
import { openFollowup } from './lead-followup.js';
import { empty, fill, head } from './parts.js';
import { callButton } from './people.js';
import { fillReminderPrompt } from './reminders.js';

// Leads: every enquiry is a lead, and this tab is where the rep works them: what the client said last time, the status, and the next
// reminder. Four views: Today (what needs action now), Last 7 days, Last month and All (the default, newest activity first).

const MAX_SHOWN = 80;

const statusTone = (status) => (status === 'deal_done' ? 'approved' : status === 'deal_lost' || status === 'not_interested' ? 'lost' : '');

// "Last contact 2 days ago" / "No follow-up logged yet"
const lastContact = (e) => (e.last_followup_at ? `Last contact ${daysAgo(new Date(e.last_followup_at))}` : 'No follow-up logged yet');

export function leadRow(app, e, now = new Date()) {
  const sub = [e.contact_name, itemsSummary(e.items, 2)].filter(Boolean).join(' · ');
  const budget = budgetTotal(e.items);
  const person = app.store.contactById(e.contact_id);
  const phone = person?.phone || app.store.clientById(e.client_id)?.phone;
  const open = isOpen(e.status);

  return h('div', { class: 'lead-card' },
    h('button', { class: 'item', onclick: () => openEnquiryPage(app, e.id) },
      h('span', { class: 'avatar' }, initials(e.client_name)),
      h('span', { class: 'grow' },
        h('span', { class: 'title' }, e.client_name),
        h('span', { class: 'sub' }, sub),
        budget ? h('span', { class: 'sub' }, `Budget ${rupees(budget).replace(/\.00$/, '')}`) : null,
        h('span', { class: 'lead-chips' }, h('span', { class: `chip ${statusTone(e.lead_status)}` }, leadLabel(e.lead_status)), followupChip(e, now)),
        e.lead_remark ? h('span', { class: 'sub lead-remark' }, `"${e.lead_remark}"`) : null,
        h('span', { class: 'sub' }, lastContact(e)))),
    open
      ? h('div', { class: 'lead-actions' },
        phone ? callButton(phone) : null,
        h('button', { class: 'btn small-btn', onclick: () => openFollowup(app, e.id) }, icon('phone', 16), 'Follow-up'))
      : null);
}

// ---- the tab ----------------------------------------------------------------------------------------------------

let view = 'all';   // 'today' | 'week' | 'month' | 'all': the default is everything, newest first
let query = '';

export function resetLeadView() {
  view = 'all';
  query = '';
}

export function renderLeads(container, app, ctx) {
  const store = app.store;
  const now = new Date();
  const all = store.enquiries;
  const counts = leadCounts(all, now);
  const open = all.filter((e) => isOpen(e.status)).length;

  const list = h('div', { class: 'list' });
  const filters = h('div', { class: 'filters lead-views', role: 'group', 'aria-label': 'Which leads' });

  const draw = () => {
    filters.replaceChildren(...LEAD_VIEWS.map((v) => h('button', {
      class: 'filter', 'aria-pressed': String(v.value === view),
      onclick() {
        view = v.value;
        draw();
      },
    }, v.value === 'today' && counts.today ? `${v.label} (${counts.today})` : v.label)));

    const shown = filterLeads(all, view, now).filter((e) => matches(e, query)).sort(byRecent).slice(0, MAX_SHOWN);

    list.replaceChildren(...(shown.length
      ? shown.map((e) => leadRow(app, e, now))
      : [view === 'today' && !query.trim()
        ? empty('check', 'Nothing to do today', 'Every follow-up is on time. Well done.')
        : empty('receipt', all.length ? 'No leads here' : 'No leads yet', all.length ? 'Try another view or word.' : 'When a client asks for a price, tap "New enquiry". Every enquiry is a lead.')]));
  };

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search client, product or remark', autocomplete: 'off', value: query, 'aria-label': 'Search leads' });
  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });

  const promptBox = h('div');
  void fillReminderPrompt(app, promptBox);

  draw();
  fill(container,
    head({
      eyebrow: `${open} open${counts.today ? ` · ${counts.today} for today` : ''}`,
      title: 'Leads',
      right: all.length ? h('button', { class: 'btn small-btn', onclick: () => openLeadFinder(app) }, icon('phone', 16), 'Update a lead') : null,
    }),
    promptBox,
    all.length ? filters : null,
    all.length ? search : null,
    list);
  ctx.fab('New enquiry', () => openEnquiryForm(app));
}

// ---- "Update a lead": pick the client, then the enquiry ----------------------------------------------------------------

export function openLeadFinder(app) {
  const state = { clientId: null, other: false, clientName: '', search: '' };
  const results = h('div', { class: 'stack' });
  let page = null;

  const drawResults = () => {
    if (!state.clientId) {
      results.replaceChildren();
      return;
    }
    const client = app.store.clientById(state.clientId);
    const found = openEnquiriesOf(app.store.enquiries, state.clientId);

    results.replaceChildren(
      h('p', { class: 'eyebrow' }, found.length ? `Open enquiries of ${client?.name ?? 'this client'}` : 'No open enquiry'),
      ...(found.length
        ? found.map((e) => h('button', { class: 'item', onclick: () => { page?.close(); openFollowup(app, e.id); } },
          h('span', { class: 'avatar' }, initials(e.client_name)),
          h('span', { class: 'grow' },
            h('span', { class: 'title' }, itemsSummary(e.items, 2)),
            h('span', { class: 'sub' }, [leadLabel(e.lead_status), lastContact(e)].join(' · '))),
          h('span', { class: 'end' }, followupChip(e))))
        : [h('p', { class: 'muted small' }, 'This client has no open enquiry. Write one first, and it becomes a lead.'),
          h('button', { class: 'btn small-btn', onclick: () => { page?.close(); openEnquiryForm(app, { preset: { client_id: state.clientId } }); } }, icon('plus', 16), 'New enquiry for this client')]));
  };

  const picker = clientPicker(app, state, { onPick: drawResults, placeholder: 'Search the client' });

  page = openPage({
    title: 'Update a lead',
    body: h('div', { class: 'stack' }, picker.searchBox, picker.slot.el, results),
  });
}

// ---- the Home card: leads that need action --------------------------------------------------------------------------

export function needsActionCard(app, ctx) {
  const now = new Date();
  const items = app.store.actionableEnquiries(now);

  if (!items.length) {
    return h('div', { class: 'card pad stack' },
      h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Leads'),
      h('p', { class: 'muted small' }, app.store.enquiries.some((e) => isOpen(e.status)) ? 'Every follow-up is on time.' : 'No open leads. When a client asks for a price, write it down in the Leads tab.'),
      h('button', { class: 'btn small-btn', onclick: () => openEnquiryForm(app) }, icon('plus', 18), 'New enquiry'));
  }

  return h('div', null,
    h('div', { class: 'section-head', style: { marginBottom: '10px' } },
      h('p', { class: 'eyebrow' }, `Leads to act on (${items.length})`),
      h('button', { class: 'link', onclick: () => ctx.goTab('enquiries') }, 'View all')),
    h('div', { class: 'list' }, items.slice(0, 4).map((e) => leadRow(app, e, now))));
}
