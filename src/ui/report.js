import { reportId } from '../core/ids.js';
import * as rules from '../core/rules.js';
import { enquiriesWorked, figuresFor } from '../core/report.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { dayString, formatTime, parseDay, rupees } from './format.js';
import { field, openPage, toast, validate } from './kit.js';

// The daily report: the numbers of the day (counted from what is saved on the phone), then the rep's own words. The manager reads it
// on the website the same day, and sees who has not sent one.

const talk = (seconds) => {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
};

const dayTitle = (day) => {
  const date = parseDay(day);
  const label = date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  return day === dayString() ? `Today, ${label.replace(/^[A-Za-z]+, /, '')}` : label;
};

// ---- the card on Home -------------------------------------------------------------------------------------------

export function reportCard(app) {
  const store = app.store;
  const today = dayString();
  const sent = store.reportFor(today)?.submitted_at ?? null;
  const f = figuresFor(store, today);

  return h('div', { class: 'card pad stack' },
    h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Today\'s report'),
    sent
      ? h('strong', null, `Sent at ${formatTime(new Date(sent))}`)
      : h('strong', null, 'Not sent yet'),
    h('p', { class: 'muted small' }, `${f.calls} ${f.calls === 1 ? 'call' : 'calls'} · ${f.meetings} ${f.meetings === 1 ? 'meeting' : 'meetings'} · ${f.enquiries_worked} ${f.enquiries_worked === 1 ? 'enquiry' : 'enquiries'} worked on`),
    h('button', { class: `btn small-btn${sent ? '' : ' primary'}`, onclick: () => openReportPage(app, today) }, icon('edit', 18), sent ? 'See or correct it' : 'Write today\'s report'));
}

// ---- the report page ----------------------------------------------------------------------------------------------

export async function openReportPage(app, day = dayString()) {
  const store = app.store;
  const code = store.profile?.employee_code ?? 'REP';
  const id = await reportId(code, day);
  const existing = store.reportFor(day);
  const f = figuresFor(store, day);
  const worked = enquiriesWorked(store, day);

  const tile = (label, value, hint) => h('div', { class: 'tile' }, h('p', { class: 'eyebrow' }, label), h('div', { class: 'num' }, String(value)), h('div', { class: 'hint' }, hint));

  const notes = field('What happened today', h('textarea', { class: 'input', rows: 5, maxLength: rules.MAX_LONG_TEXT, placeholder: 'Who you met, what you sold, what you learnt ...', value: existing?.notes ?? '' }));
  const plan = field('Plan for tomorrow (optional)', h('textarea', { class: 'input', rows: 3, maxLength: rules.MAX_NOTE, placeholder: 'Visits, calls, prices to send ...', value: existing?.tomorrow_plan ?? '' }));
  const issues = field('Need help with (optional)', h('textarea', { class: 'input', rows: 3, maxLength: rules.MAX_NOTE, placeholder: 'Anything your manager should know or fix', value: existing?.issues ?? '' }));

  const send = h('button', { class: 'btn primary block' }, existing?.submitted_at ? 'Update report' : 'Send report');
  send.addEventListener('click', async () => {
    const ok = validate([
      [notes, rules.required(notes.input.value, { min: 3, max: rules.MAX_LONG_TEXT, label: 'What happened today' })],
      [plan, rules.optional(plan.input.value, { max: rules.MAX_NOTE, label: 'Plan' })],
      [issues, rules.optional(issues.input.value, { max: rules.MAX_NOTE, label: 'Help needed' })],
    ]);
    if (!ok) return;

    send.disabled = true;
    try {
      await store.saveReport({ id, report_date: day, notes: notes.input.value, tomorrow_plan: plan.input.value, issues: issues.input.value, figures: figuresFor(store, day), submit: true });
      toast(app.sync?.status.connected ? 'Report sent. It goes to the office with your next sync.' : 'Report saved. Connect to the office to send it.');
      page.close();
    } catch (error) {
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
      send.disabled = false;
    }
  });

  const earlier = store.reports.filter((r) => r.report_date !== day).slice(0, 10);

  const page = openPage({
    title: 'Daily report',
    body: h('div', { class: 'stack' },
      h('div', null, h('p', { class: 'eyebrow' }, 'Report for'), h('h2', { style: { fontSize: '19px' } }, dayTitle(day))),
      h('div', { class: 'tiles' },
        tile('Client calls', f.calls, f.calls_missed ? `${f.calls_missed} missed · ${talk(f.talk_seconds)}` : talk(f.talk_seconds)),
        tile('Meetings', f.meetings, 'Written today')),
      h('div', { class: 'tiles' },
        tile('New enquiries', f.enquiries_new, 'Opened today'),
        tile('Enquiries worked', f.enquiries_worked, 'Note or status change')),
      h('div', { class: 'tiles' }, tile('Expenses', rupees(f.expenses_paise).replace(/\.00$/, ''), 'Saved today')),
      worked.length ? h('div', { class: 'card pad' },
        h('p', { class: 'eyebrow' }, 'Enquiries you worked on'),
        ...worked.map((e) => h('p', { class: 'small', style: { padding: '3px 0' } }, `${e.client_name}: ${e.items.map((i) => i.product).slice(0, 3).join(', ')}`))) : null,
      notes.el, plan.el, issues.el,
      h('p', { class: 'muted small' }, 'The numbers above are counted from what is saved on your phone and are sent with the report.'),
      earlier.length ? h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Earlier reports'),
        h('div', { class: 'list' }, earlier.map((r) => h('button', { class: 'item', onclick: () => { page.close(); openReportPage(app, r.report_date); } },
          h('span', { class: 'grow' }, h('span', { class: 'title' }, dayTitle(r.report_date)), h('span', { class: 'sub' }, r.notes || 'No text')),
          h('span', { class: 'end' }, h('span', { class: `chip ${r.submitted_at ? 'approved' : ''}` }, r.submitted_at ? 'Sent' : 'Draft')))))) : null),
    footer: send,
  });
}
