// Leads (v1.15): a lead IS an enquiry. This is the follow-up layer on top of it: where the follow-up stands (status), what the client said
// last time (remark) and the next reminder (the enquiry's `next_followup_at`). Pure functions, no screen and no storage here.
import { needsAction } from './enquiry.js';

export const MAX_REMARK = 300;

// value, label, when to call next by default (a suggestion the rep can change), and the stage it finishes the enquiry with.
export const LEAD_STATUSES = [
  { value: 'new', label: 'New lead', delay: { days: 1, hour: 10 } },
  { value: 'price_sent', label: 'Price sent', delay: { days: 3, hour: 10 } },
  { value: 'better_option', label: 'Asked for better option', delay: { days: 1, hour: 10 } },
  { value: 'call_not_picking', label: 'Call not picking', delay: { hours: 3 } },
  { value: 'want_less_price', label: 'Want less price', delay: { days: 1, hour: 10 } },
  { value: 'interested', label: 'Interested', delay: { days: 2, hour: 10 } },
  { value: 'waiting', label: 'Waiting for decision', delay: { days: 7, hour: 10 } },
  { value: 'not_interested', label: 'Not interested', delay: { days: 30, hour: 10 } },
  { value: 'deal_done', label: 'Deal done', closes: 'won' },
  { value: 'deal_lost', label: 'Deal lost', closes: 'lost' },
];

export const isLeadStatus = (v) => LEAD_STATUSES.some((s) => s.value === v);
export const leadLabel = (v) => LEAD_STATUSES.find((s) => s.value === (v ?? 'new'))?.label ?? 'New lead';
// The stage that a lead status finishes the enquiry with ('won' / 'lost'), or null for a status that keeps it open.
export const closesTo = (v) => LEAD_STATUSES.find((s) => s.value === v)?.closes ?? null;

const WORK_START = 9;
const WORK_END = 19;

/**
 * The reminder a status suggests, or null for Deal done / Deal lost. "Call not picking" is three hours later, but never in the
 * night: after 7 pm or before 9 am it moves to 10 am (the next morning when it is already late).
 */
export function suggestedReminder(status, now = new Date()) {
  const rule = LEAD_STATUSES.find((s) => s.value === status)?.delay;
  if (!rule) return null;

  if (rule.hours) {
    const at = new Date(now.getTime() + rule.hours * 3_600_000);
    if (at.getHours() >= WORK_END || at.getHours() < WORK_START) {
      const morning = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 10, 0, 0, 0);
      if (at.getHours() >= WORK_END) morning.setDate(morning.getDate() + 1);
      return morning;
    }
    return at;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + rule.days, rule.hour, 0, 0, 0);
}

// ---- the four views ---------------------------------------------------------------------------------------------------------

export const LEAD_VIEWS = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last month' },
  { value: 'all', label: 'All' },
];

const DAY = 86_400_000;

// today = what needs action now (late, due today, or untouched), the same rule as the Home card and the tab badge;
// week / month = leads opened in the last 7 / 30 days; all = everything.
export function inView(enquiry, view, now = new Date()) {
  if (view === 'today') return needsAction(enquiry, now);
  if (view === 'week') return Date.parse(enquiry.opened_at) >= now.getTime() - 7 * DAY;
  if (view === 'month') return Date.parse(enquiry.opened_at) >= now.getTime() - 30 * DAY;
  return true;
}

export const filterLeads = (list, view, now = new Date()) => list.filter((e) => inView(e, view, now));

export function leadCounts(list, now = new Date()) {
  const out = {};
  for (const v of LEAD_VIEWS) out[v.value] = filterLeads(list, v.value, now).length;
  return out;
}

// The newest activity first: the last follow-up, else the last change, else when it was opened.
const activity = (e) => Date.parse(e.last_followup_at || e.updated_at || e.opened_at) || 0;
export const byRecent = (a, b) => activity(b) - activity(a);

export function matches(enquiry, text) {
  const q = String(text ?? '').trim().toLowerCase();
  if (!q) return true;
  const hay = [enquiry.client_name, enquiry.contact_name, enquiry.lead_remark, leadLabel(enquiry.lead_status),
    ...(enquiry.items ?? []).flatMap((i) => [i.product, i.brands])].join(' ').toLowerCase();
  return hay.includes(q);
}

// The line a follow-up adds to the enquiry's timeline: "Follow-up: Price sent: will confirm on Friday".
export function leadLine(status, remark) {
  const r = String(remark ?? '').trim();
  return `Follow-up: ${leadLabel(status)}${r ? `: ${r}` : ''}`;
}
