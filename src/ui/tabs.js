import { h, icon } from './dom.js';
import { openClientForm, openExpenseForm, openMeetingForm } from './forms.js';
import { capitalize, dayLabel, formatDay, formatDayTime, parseDay, rupees, sameDay } from './format.js';

const empty = (iconName, title, text) =>
  h('div', { class: 'empty' }, icon(iconName, 52), h('h2', null, title), h('p', null, text));

const fab = (label, onclick) => h('button', { class: 'btn primary fab', onclick }, icon('plus', 18), label);

const stat = (label, value, hint, onclick) =>
  h('button', { class: 'card stat', onclick },
    h('p', { class: 'eyebrow', style: { marginBottom: '6px' } }, label),
    h('div', { class: 'num' }, value),
    h('div', { class: 'hint' }, hint));

export function statusChip(status) {
  return h('span', { class: `chip ${status === 'approved' || status === 'rejected' ? status : ''}` }, capitalize(status));
}

// ---- Home --------------------------------------------------------------------

export function renderHome(container, app, { goTab }) {
  const store = app.store;
  const now = new Date();
  const expenses = store.expenses;
  const meetings = store.meetings;

  const today = expenses.filter((e) => sameDay(parseDay(e.expense_date), now));
  const todayTotal = today.reduce((sum, e) => sum + e.amount_paise, 0);
  const monthTotal = expenses
    .filter((e) => {
      const d = parseDay(e.expense_date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, e) => sum + e.amount_paise, 0);
  const meetingsToday = meetings.filter((m) => sameDay(new Date(m.meeting_at), now)).length;

  // follow-ups that are late, or due within the next 7 days
  const horizon = now.getTime() + 7 * 86_400_000;
  const followups = meetings
    .filter((m) => m.next_followup_at && Date.parse(m.next_followup_at) < horizon)
    .sort((a, b) => a.next_followup_at.localeCompare(b.next_followup_at))
    .slice(0, 5);

  const profile = store.profile;
  const first = (profile?.name ?? '').split(' ')[0];

  container.replaceChildren(
    h('div', { class: 'stack reveal' },
      h('div', null,
        h('h2', { style: { fontSize: '22px' } }, `Hello${first ? `, ${first}` : ''}`),
        profile ? h('p', { class: 'muted' }, `Employee code ${profile.employee_code}`) : null),
      h('div', { class: 'grid2' },
        stat('Spent today', rupees(todayTotal), `${today.length} ${today.length === 1 ? 'expense' : 'expenses'}`, () => goTab('expenses')),
        stat('Meetings today', String(meetingsToday), 'tap to see all', () => goTab('meetings'))),
      stat('Spent this month', rupees(monthTotal), 'all categories', () => goTab('expenses')),
      h('div', null,
        h('p', { class: 'eyebrow' }, 'Follow-ups'),
        followups.length
          ? h('div', { class: 'list' }, followups.map((m) => meetingItem(app, m)))
          : h('div', { class: 'card pad muted' }, 'No follow-ups due in the next 7 days.')),
      h('div', null,
        h('p', { class: 'eyebrow' }, 'Office sync'),
        h('div', { class: 'card pad stack' },
          h('strong', null, `${store.unsyncedCount} records saved only on this phone`),
          h('p', { class: 'muted small' }, 'Sending to the office is not connected yet. Your data is safe here. Use Settings > Export to share a file with your manager.'),
          h('button', { class: 'btn', disabled: true }, 'Sync now (coming soon)')))),
  );
}

// ---- Expenses ----------------------------------------------------------------

const CATEGORY_ICON = { travel: 'calendar', food: 'receipt', lodging: 'home', fuel: 'alarm', other: 'receipt' };

export function renderExpenses(container, app) {
  const expenses = app.store.expenses;
  const now = new Date();
  const monthTotal = expenses
    .filter((e) => {
      const d = parseDay(e.expense_date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, e) => sum + e.amount_paise, 0);

  container.replaceChildren(
    expenses.length
      ? h('div', { class: 'list reveal' },
          h('div', { class: 'card pad row' }, h('span', { class: 'grow' }, 'This month'), h('strong', { style: { fontSize: '18px' } }, rupees(monthTotal))),
          expenses.map((e) => h('button', { class: 'item', onclick: () => openExpenseForm(app, e) },
            h('span', { class: 'avatar' }, icon(CATEGORY_ICON[e.category] ?? 'receipt', 20)),
            h('span', { class: 'grow' },
              h('span', { class: 'title' }, rupees(e.amount_paise)),
              h('span', { class: 'sub', style: { display: 'block' } }, `${capitalize(e.category)} · ${dayLabel(parseDay(e.expense_date))}${e.note ? `\n${e.note}` : ''}`.replace(/\n/g, ' · '))),
            h('span', { class: 'end' }, statusChip(e.status), e.has_bill ? h('span', { class: 'muted', title: 'Has a bill photo' }, icon('image', 16)) : null))))
      : empty('receipt', 'No expenses yet', 'Tap "Add expense" to save your first one, with a photo of the bill.'),
    fab('Add expense', () => openExpenseForm(app)),
  );
}

// ---- Clients -----------------------------------------------------------------

let clientQuery = '';

export function renderClients(container, app) {
  const all = app.store.clients;
  const list = h('div', { class: 'list' });

  const draw = () => {
    const q = clientQuery.trim().toLowerCase();
    const shown = q ? all.filter((c) => `${c.name} ${c.company} ${c.city} ${c.phone}`.toLowerCase().includes(q)) : all;

    list.replaceChildren(...(shown.length
      ? shown.map((c) => h('button', { class: 'item', onclick: () => openClientForm(app, c) },
          h('span', { class: 'avatar' }, c.name[0].toUpperCase()),
          h('span', { class: 'grow' },
            h('span', { class: 'title' }, c.name),
            h('span', { class: 'sub', style: { display: 'block' } }, [c.company, c.city, c.phone].filter(Boolean).join(' · ')))))
      : [empty('search', 'Nothing found', 'Try another name, company or city.')]));
  };

  if (!all.length) {
    container.replaceChildren(
      empty('users', 'No clients yet', 'Save the people and companies you meet. You can pick them when you write a meeting.'),
      fab('Add client', () => openClientForm(app)),
    );
    return;
  }

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search clients', autocomplete: 'off', value: clientQuery, 'aria-label': 'Search clients' });
  search.addEventListener('input', () => {
    clientQuery = search.value;
    draw();
  });

  draw();
  container.replaceChildren(h('div', { class: 'stack reveal' }, search, list), fab('Add client', () => openClientForm(app)));
}

// ---- Meetings ----------------------------------------------------------------

export function meetingItem(app, m) {
  const follow = m.next_followup_at ? new Date(m.next_followup_at) : null;
  const late = follow && follow.getTime() < Date.now();

  return h('button', { class: 'item', onclick: () => openMeetingForm(app, m) },
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, m.client_name),
      h('span', { class: 'sub', style: { display: 'block' } }, `${formatDayTime(new Date(m.meeting_at))}${m.purpose ? ` · ${m.purpose}` : ''}`)),
    follow ? h('span', { class: 'end' }, h('span', { class: late ? 'chip late' : 'chip' }, icon('alarm', 12), ` ${formatDay(follow)}`)) : null);
}

export function renderMeetings(container, app) {
  const meetings = app.store.meetings;

  container.replaceChildren(
    meetings.length
      ? h('div', { class: 'list reveal' }, meetings.map((m) => meetingItem(app, m)))
      : empty('calendar', 'No meetings yet', 'Write down what you discussed, and set a follow-up date so you do not forget.'),
    fab('Add meeting', () => openMeetingForm(app)),
  );
}
