import { BILL_TYPE_LABELS, categoryLabel } from '../core/rules.js';
import { openClientPage } from './clients.js';
import { needsActionCard } from './enquiries.js';
import { reportCard } from './report.js';
import { h, icon, svg } from './dom.js';
import { openClientForm, openExpenseForm, openMeetingForm } from './forms.js';
import { callsCard } from './calls.js';
import { capitalize, dayLabel, dayString, formatDay, formatDayTime, formatHeadDay, formatTime, initials, parseDay, rupees, sameDay, splitRupees } from './format.js';
import { officeCard } from './office.js';
import { empty, fill, head } from './parts.js';
import { openContactForm } from './people.js';
import { openSettings } from './settings.js';

// The four main screens. Each one fills the scrolling view; `ctx` gives them goTab(id) and fab(label, onclick).

const CATEGORY_ICON = { travel: 'car', food: 'utensils', lodging: 'bed', fuel: 'fuel', parking: 'parking', gifting: 'gift', other: 'receipt' };
const WORK_AREA_SHORT = { local: 'Local', outstation: 'Outstation' };

const statusChip = (status) => h('span', { class: `chip ${status === 'approved' || status === 'rejected' ? status : ''}` }, capitalize(status));

const monthTotal = (expenses, now = new Date()) =>
  expenses
    .filter((e) => {
      const d = parseDay(e.expense_date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, e) => sum + e.amount_paise, 0);

// ---- Home --------------------------------------------------------------------

// Two thin ellipses and a centre dot: the logo's atom orbit, drawn quietly in the corner of the hero card.
function orbit() {
  const ellipse = (angle) => svg('ellipse', { cx: 50, cy: 50, rx: 44, ry: 16, transform: `rotate(${angle} 50 50)`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1 });
  return svg('svg', { class: 'hero-orbit', viewBox: '0 0 100 100', 'aria-hidden': 'true' }, ellipse(35), ellipse(-35), svg('circle', { cx: 50, cy: 50, r: 3, fill: 'currentColor' }));
}

// totals of the last 7 days, today last
function lastSevenDays(expenses, now) {
  return Array.from({ length: 7 }, (_, i) => {
    const day = dayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i)));
    return expenses.filter((e) => e.expense_date === day).reduce((sum, e) => sum + e.amount_paise, 0);
  });
}

export function renderHome(container, app, ctx) {
  const store = app.store;
  const now = new Date();
  const expenses = store.expenses;
  const meetings = store.meetings;

  const today = expenses.filter((e) => sameDay(parseDay(e.expense_date), now));
  const todayTotal = today.reduce((sum, e) => sum + e.amount_paise, 0);
  const month = splitRupees(monthTotal(expenses, now));
  const week = lastSevenDays(expenses, now);
  const top = Math.max(1, ...week);

  const meetingsToday = meetings.filter((m) => sameDay(new Date(m.meeting_at), now));
  const nextToday = meetingsToday.map((m) => new Date(m.meeting_at)).filter((d) => d > now).sort((a, b) => a - b)[0];

  // follow-ups that are late, or due within the next 7 days
  const horizon = now.getTime() + 7 * 86_400_000;
  const followups = meetings
    .filter((m) => m.next_followup_at && Date.parse(m.next_followup_at) < horizon)
    .sort((a, b) => a.next_followup_at.localeCompare(b.next_followup_at))
    .slice(0, 5);

  const profile = store.profile;
  const first = (profile?.name ?? '').split(' ')[0];

  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Spending over the last 7 days' },
    week.map((total, i) => {
      const bar = h('i', { class: i === 6 ? 'on' : null });
      bar.style.height = `${Math.max(4, Math.round((34 * total) / top))}px`;
      return bar;
    }));

  fill(container,
    head({
      eyebrow: formatHeadDay(now),
      title: `Hello${first ? `, ${first}` : ''}`,
      right: [
        h('button', { class: 'icon-btn', 'aria-label': 'Lock now', onclick: () => app.lock() }, icon('lock', 20)),
        h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => openSettings(app) }, icon('menu', 20)),
      ],
    }),

    h('section', { class: 'hero' },
      orbit(),
      h('p', { class: 'eyebrow' }, 'Spent this month'),
      h('div', { class: 'hero-amount' }, month.whole, h('small', null, month.fraction)),
      h('div', { class: 'hero-foot' },
        h('div', null,
          h('p', { class: 'hero-label' }, 'Today'),
          h('p', { class: 'hero-today' }, `${rupees(todayTotal).replace(/\.00$/, '')} · ${today.length} ${today.length === 1 ? 'expense' : 'expenses'}`)),
        bars)),

    h('div', { class: 'tiles' },
      h('button', { class: 'tile', onclick: () => ctx.goTab('meetings') },
        h('p', { class: 'eyebrow' }, 'Meetings today'),
        h('div', { class: 'num' }, String(meetingsToday.length)),
        h('div', { class: 'hint' }, nextToday ? `Next at ${formatTime(nextToday)}` : meetingsToday.length ? 'None later today' : 'Nothing planned')),
      h('div', { class: 'tile' },
        h('p', { class: 'eyebrow' }, 'Not synced'),
        h('div', { class: 'num' }, String(store.unsyncedCount)),
        h('div', { class: 'hint' }, app.sync?.status.connected ? 'Waiting for the office' : 'Saved on this phone'))),

    callsCard(app),

    needsActionCard(app, ctx),

    reportCard(app),

    h('div', null,
      h('div', { class: 'section-head', style: { marginBottom: '10px' } },
        h('p', { class: 'eyebrow' }, 'Meeting follow-ups'),
        h('button', { class: 'link', onclick: () => ctx.goTab('meetings') }, 'View all')),
      followups.length
        ? h('div', { class: 'list' }, followups.map((m) => meetingRow(app, m)))
        : h('div', { class: 'card pad muted' }, 'No follow-ups due in the next 7 days.')),

    officeCard(app, ctx),
  );
  ctx.fab(null);
}

// ---- Expenses ----------------------------------------------------------------

const FILTERS = [['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']];
let expenseFilter = 'all';

export function renderExpenses(container, app, ctx) {
  const all = app.store.expenses;
  const list = h('div', { class: 'list' });
  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by status' });

  const draw = () => {
    filters.replaceChildren(...FILTERS.map(([value, label]) => h('button', {
      class: 'filter', 'aria-pressed': String(value === expenseFilter),
      onclick() {
        expenseFilter = value;
        draw();
      },
    }, label)));

    const shown = expenseFilter === 'all' ? all : all.filter((e) => e.status === expenseFilter);
    const rows = [];
    let lastDay = null;

    for (const e of shown) {
      if (e.expense_date !== lastDay) {
        lastDay = e.expense_date;
        rows.push(h('p', { class: 'day-label' }, dayLabel(parseDay(e.expense_date))));
      }
      rows.push(h('button', { class: 'item', onclick: () => openExpenseForm(app, e) },
        h('span', { class: 'tile-icon' }, icon(CATEGORY_ICON[e.category] ?? 'receipt', 20)),
        h('span', { class: 'grow' },
          h('span', { class: 'title amt' }, rupees(e.amount_paise)),
          h('span', { class: 'sub' }, [categoryLabel(e.category), e.work_area ? WORK_AREA_SHORT[e.work_area] : null, e.bill_type ? BILL_TYPE_LABELS[e.bill_type] : null].filter(Boolean).join(' · ')),
          e.note ? h('span', { class: 'sub note' }, e.note) : null),
        h('span', { class: 'end' }, statusChip(e.status), e.has_bill ? h('span', { class: 'bill-flag', title: 'Has a bill photo' }, icon('image', 16)) : null)));
    }

    list.replaceChildren(...(rows.length ? rows : [empty('receipt', `No ${expenseFilter === 'all' ? '' : `${expenseFilter} `}expenses`, 'Tap "Add expense" to save one, with a photo of the bill.')]));
  };

  draw();
  fill(container,
    head({ eyebrow: 'This month', title: 'Expenses', right: h('span', { class: 'head-amount num' }, rupees(monthTotal(all))) }),
    all.length ? filters : null,
    list,
  );
  ctx.fab('Add expense', () => openExpenseForm(app));
}

// ---- Clients -----------------------------------------------------------------

let clientQuery = '';
let clientScope = 'all'; // 'all' | 'mine' | 'people' (people without a company)
let clientPlace = '';

// The search words and filters of the screens are kept while the app is open; when another rep (or the same one, after a lock) comes in
// they start fresh.
export function resetTabViews() {
  clientQuery = '';
  clientScope = 'all';
  clientPlace = '';
  expenseFilter = 'all';
}

export function renderClients(container, app, ctx) {
  const store = app.store;
  const all = store.clients;
  const alone = store.loosePeople; // people without a company
  const me = store.profile?.employee_code;
  const list = h('div', { class: 'client-list' });
  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Whose clients' });

  // how many people are saved at each client (one pass)
  const people = new Map();
  for (const p of store.contacts) if (p.client_id) people.set(p.client_id, (people.get(p.client_id) ?? 0) + 1);

  const places = [...new Set(all.map((c) => c.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (clientPlace && !places.includes(clientPlace)) clientPlace = '';

  const placeSelect = h('select', { class: 'input', 'aria-label': 'Filter by place' },
    h('option', { value: '' }, 'All places'),
    ...places.map((p) => h('option', { value: p }, p)));
  placeSelect.value = clientPlace;
  placeSelect.addEventListener('change', () => {
    clientPlace = placeSelect.value;
    draw();
  });

  const companyRow = (c) => h('button', { class: 'item', onclick: () => openClientPage(app, c.id) },
    h('span', { class: 'avatar' }, initials(c.name)),
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, c.name),
      h('span', { class: 'sub' }, [c.city, people.get(c.id) ? `${people.get(c.id)} ${people.get(c.id) === 1 ? 'person' : 'people'}` : 'No people yet', c.assigned_to_name && c.assigned_to_code !== me ? `Works with ${c.assigned_to_name}` : null].filter(Boolean).join(' · ')),
      h('span', { class: 'sub added' }, `Added by ${store.addedBy(c)}`)));

  const personRow = (p) => h('button', { class: 'item', onclick: () => openContactForm(app, { existing: p }) },
    h('span', { class: 'avatar' }, initials(p.name)),
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, p.name),
      h('span', { class: 'sub' }, [p.position, p.phone].filter(Boolean).join(' · ') || 'No company'),
      h('span', { class: 'sub added' }, `Added by ${store.addedBy(p)}`)));

  const draw = () => {
    filters.replaceChildren(...[['all', 'All'], ['mine', 'Mine'], ['people', 'People']].map(([value, label]) => h('button', {
      class: 'filter', 'aria-pressed': String(value === clientScope),
      onclick() {
        clientScope = value;
        draw();
      },
    }, label)));

    const q = clientQuery.trim().toLowerCase();

    const companies = clientScope === 'people' ? [] : all.filter((c) => (clientScope === 'all' || (me && c.assigned_to_code === me))
      && (!clientPlace || c.city === clientPlace)
      && (!q || `${c.name} ${c.company} ${c.city} ${c.phone}`.toLowerCase().includes(q)
        || store.contactsOf(c.id).some((p) => `${p.name} ${p.phone} ${p.position}`.toLowerCase().includes(q))));

    // people without a company have no place, so a place filter leaves them out
    const persons = clientPlace ? [] : alone.filter((p) => (clientScope !== 'mine' || store.canEdit(p))
      && (!q || `${p.name} ${p.phone} ${p.position} ${p.email}`.toLowerCase().includes(q)));

    const labelled = companies.length > 0 && persons.length > 0;
    const parts = [
      labelled ? h('p', { class: 'eyebrow list-label' }, `Companies (${companies.length})`) : null,
      companies.length ? h('div', { class: 'list' }, companies.map(companyRow)) : null,
      labelled ? h('p', { class: 'eyebrow list-label' }, `People without a company (${persons.length})`) : null,
      persons.length ? h('div', { class: 'list' }, persons.map(personRow)) : null,
    ];

    if (!companies.length && !persons.length) {
      const none = clientScope === 'mine' && !q && !clientPlace;
      const onlyPeople = clientScope === 'people' && !q;
      parts.push(empty(onlyPeople ? 'users' : 'search',
        none ? 'None given to you yet' : onlyPeople ? 'No one here yet' : 'Nothing found',
        none ? 'Clients your manager gives you, or that you add, show here.'
          : onlyPeople ? 'Customers who buy on their own, with no company, show here. Use "Add contact person".'
            : 'Try another name, person, number or place.'));
    }

    list.replaceChildren(...parts.filter(Boolean));
  };

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search clients, people or numbers', autocomplete: 'off', value: clientQuery, 'aria-label': 'Search clients' });
  search.addEventListener('input', () => {
    clientQuery = search.value;
    draw();
  });

  const any = all.length > 0 || alone.length > 0;
  const peopleWord = alone.length === 1 ? 'person' : 'people';

  draw();
  fill(container,
    head({ eyebrow: `${all.length} ${all.length === 1 ? 'company' : 'companies'}${alone.length ? ` · ${alone.length} ${peopleWord} on their own` : ''}`, title: 'Clients' }),
    any ? h('div', { class: 'client-tools' }, filters, search, places.length > 1 && clientScope !== 'people' ? placeSelect : null) : null,
    any ? list : empty('users', 'No clients yet', 'Save the companies you deal with and the people who work there. Everybody on the team sees them.'),
  );
  ctx.fab('Add client', () => openClientForm(app), { label: 'Add contact person', onclick: () => openContactForm(app, { client: null }) });
}

// ---- Meetings ----------------------------------------------------------------

export function meetingRow(app, m) {
  const follow = m.next_followup_at ? new Date(m.next_followup_at) : null;
  const late = follow && follow.getTime() < Date.now();

  return h('button', { class: 'item', onclick: () => openMeetingForm(app, m) },
    h('span', { class: 'avatar' }, initials(m.client_name)),
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, m.client_name),
      h('span', { class: 'sub' }, `${formatDayTime(new Date(m.meeting_at))}${m.purpose ? ` · ${m.purpose}` : ''}`)),
    follow ? h('span', { class: 'end' }, h('span', { class: `chip${late ? ' late' : ''}` }, icon('alarm', 12), formatDay(follow))) : null);
}

export function renderMeetings(container, app, ctx) {
  const meetings = app.store.meetings;

  fill(container,
    head({ eyebrow: `${meetings.length} written`, title: 'Meetings' }),
    meetings.length
      ? h('div', { class: 'list' }, meetings.map((m) => meetingRow(app, m)))
      : empty('calendar', 'No meetings yet', 'Write down what you discussed, and set a follow-up date so you do not forget.'),
  );
  ctx.fab('Add meeting', () => openMeetingForm(app));
}
