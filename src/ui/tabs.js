import { h, icon, svg } from './dom.js';
import { openClientForm, openExpenseForm, openMeetingForm } from './forms.js';
import { capitalize, dayLabel, dayString, formatDay, formatDayTime, formatHeadDay, formatTime, initials, parseDay, rupees, sameDay, splitRupees } from './format.js';
import { openSettings } from './settings.js';

// The four main screens. Each one fills the scrolling view; `ctx` gives them goTab(id) and fab(label, onclick).

const CATEGORY_ICON = { travel: 'car', food: 'utensils', lodging: 'bed', fuel: 'fuel', other: 'receipt' };

// replaceChildren() would print the word "null" for an empty part: this skips them
const fill = (el, ...parts) => el.replaceChildren(...parts.filter(Boolean));

const empty = (iconName, title, text) =>
  h('div', { class: 'empty' }, icon(iconName, 52), h('h2', null, title), h('p', null, text));

// Large title row: small mono eyebrow, Sora title, optional things on the right.
function head({ eyebrow, title, right }) {
  return h('header', { class: 'head' },
    h('div', { class: 'grow' }, eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null, h('h1', null, title)),
    right ? h('div', { class: 'head-right' }, right) : null);
}

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
        h('div', { class: 'hint' }, 'Saved on this phone'))),

    h('div', null,
      h('div', { class: 'section-head', style: { marginBottom: '10px' } },
        h('p', { class: 'eyebrow' }, 'Follow-ups'),
        h('button', { class: 'link', onclick: () => ctx.goTab('meetings') }, 'View all')),
      followups.length
        ? h('div', { class: 'list' }, followups.map((m) => meetingRow(app, m)))
        : h('div', { class: 'card pad muted' }, 'No follow-ups due in the next 7 days.')),

    h('div', { class: 'card pad stack' },
      h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Office sync'),
      h('p', { class: 'muted small' }, 'Sending to the office is not connected yet. Your data is safe here. Use Settings > Export to share a file with your manager.'),
      h('button', { class: 'btn small-btn', disabled: true }, 'Sync now (coming soon)')),
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
          h('span', { class: 'sub' }, `${capitalize(e.category)}${e.note ? ` · ${e.note}` : ''}`)),
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

export function renderClients(container, app, ctx) {
  const all = app.store.clients;
  const list = h('div', { class: 'list' });

  const draw = () => {
    const q = clientQuery.trim().toLowerCase();
    const shown = q ? all.filter((c) => `${c.name} ${c.company} ${c.city} ${c.phone}`.toLowerCase().includes(q)) : all;

    list.replaceChildren(...(shown.length
      ? shown.map((c) => h('button', { class: 'item', onclick: () => openClientForm(app, c) },
          h('span', { class: 'avatar' }, initials(c.name)),
          h('span', { class: 'grow' },
            h('span', { class: 'title' }, c.name),
            h('span', { class: 'sub' }, [c.company, c.city, c.phone].filter(Boolean).join(' · ') || 'No details yet'))))
      : [empty('search', 'Nothing found', 'Try another name, company or city.')]));
  };

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search clients', autocomplete: 'off', value: clientQuery, 'aria-label': 'Search clients' });
  search.addEventListener('input', () => {
    clientQuery = search.value;
    draw();
  });

  draw();
  fill(container,
    head({ eyebrow: `${all.length} saved`, title: 'Clients' }),
    all.length ? search : null,
    all.length ? list : empty('users', 'No clients yet', 'Save the people and companies you meet. You can pick them when you write a meeting.'),
  );
  ctx.fab('Add client', () => openClientForm(app));
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
