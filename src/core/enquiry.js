// What an enquiry is on the phone: the stages, and which enquiries need the rep's action. The office server uses the same
// stage names (docs/sales-api.md in the website project).

export const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'price_to_send', label: 'Price to send' },
  { value: 'price_sent', label: 'Price sent' },
  { value: 'callback', label: 'Call back' },
  { value: 'meeting_planned', label: 'Meeting planned' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'won', label: 'Order received' },
  { value: 'lost', label: 'Lost' },
];

export const OPEN = ['new', 'price_to_send', 'price_sent', 'callback', 'meeting_planned', 'negotiation'];
export const CLOSED = ['won', 'lost'];

export const MAX_ITEMS = 10;
export const MAX_TIMELINE = 100;
export const MAX_BUDGET_PAISE = 100_000_000_000; // 100 crore rupees: far above any real enquiry, still safe as a whole number

export const isOpen = (status) => OPEN.includes(status);
export const isStatus = (status) => STATUSES.some((s) => s.value === status);
export const statusLabel = (status) => STATUSES.find((s) => s.value === status)?.label ?? status;

// An open enquiry nobody has touched for this long is "idle" and asks for action even without a follow-up date.
export const IDLE_DAYS = 3;

/**
 * How urgent is this enquiry right now?
 *  'overdue'  the follow-up moment has passed
 *  'today'    the follow-up is later today
 *  'idle'     open, no follow-up set, and untouched for 3 days
 *  'planned'  open with a follow-up in the future (not today)
 *  'none'     closed, or open with nothing due yet
 */
export function urgency(enquiry, now = new Date()) {
  if (!isOpen(enquiry.status)) return 'none';

  if (enquiry.next_followup_at) {
    const at = new Date(enquiry.next_followup_at);
    if (at <= now) return 'overdue';

    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return at < endOfToday ? 'today' : 'planned';
  }

  const touched = new Date(enquiry.updated_at ?? enquiry.opened_at);
  return now - touched > IDLE_DAYS * 86_400_000 ? 'idle' : 'none';
}

export const needsAction = (enquiry, now = new Date()) => ['overdue', 'today', 'idle'].includes(urgency(enquiry, now));

// the most urgent first: overdue (oldest first), today, idle
const ORDER = { overdue: 0, today: 1, idle: 2, planned: 3, none: 4 };

export function byUrgency(a, b, now = new Date()) {
  const ua = ORDER[urgency(a, now)];
  const ub = ORDER[urgency(b, now)];
  if (ua !== ub) return ua - ub;

  const fa = a.next_followup_at ? Date.parse(a.next_followup_at) : Infinity;
  const fb = b.next_followup_at ? Date.parse(b.next_followup_at) : Infinity;
  return fa - fb || Date.parse(b.opened_at) - Date.parse(a.opened_at);
}

// "Muffle Furnace, Hot Air Oven x2 +1 more"
export function itemsSummary(items, max = 3) {
  const names = items.slice(0, max).map((i) => `${i.product}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ');
  return items.length > max ? `${names} +${items.length - max} more` : names;
}

export const budgetTotal = (items) => items.reduce((sum, i) => sum + (i.budget_paise ?? 0), 0);
