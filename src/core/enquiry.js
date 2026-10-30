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

// ---- how the enquiry came in ("came through"): optional, one of these keys or null. The office uses the same keys. ----

export const SOURCES = [
  { value: 'call', label: 'Call' },
  { value: 'walkin', label: 'Walk-in' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'reference', label: 'Reference' },
];

export const isSource = (value) => SOURCES.some((s) => s.value === value);
export const sourceLabel = (value) => SOURCES.find((s) => s.value === value)?.label ?? '';

// ---- helpers of the "New enquiry" form (pure, so they are tested without a screen) -----------------------------------------

const lower = (text) => String(text ?? '').trim().toLowerCase();
const stamp = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

// The rep's latest clients, newest first, once each: from their enquiries (last touched) and their meetings (visits already held).
// Only clients that still exist in the pool. Returns [{ client, at }].
export function recentClients({ enquiries = [], meetings = [], clients = [], now = new Date(), max = 5 } = {}) {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const latest = new Map();
  const seen = (id, at) => {
    if (id && byId.has(id) && at > (latest.get(id) ?? 0)) latest.set(id, at);
  };

  for (const e of enquiries) seen(e.client_id, stamp(e.updated_at ?? e.opened_at));
  for (const m of meetings) {
    if (m.status && m.status !== 'done') continue; // a planned, moved or missed visit is not a visit that happened
    const at = stamp(m.meeting_at);
    if (at <= now.getTime()) seen(m.client_id, at);
  }

  return [...latest].sort((a, b) => b[1] - a[1]).slice(0, max).map(([id, at]) => ({ client: byId.get(id), at }));
}

// When the rep last visited the client (a meeting that has already happened), as a Date, or null.
export function lastVisit(meetings, clientId, now = new Date()) {
  const times = meetings.filter((m) => m.client_id === clientId && (!m.status || m.status === 'done')).map((m) => stamp(m.meeting_at)).filter((t) => t > 0 && t <= now.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

// "today", "yesterday", "3 days ago" (whole calendar days)
export function daysAgo(date, now = new Date()) {
  const day = (d) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
  const n = Math.max(0, day(now) - day(date));
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

// Clients whose name or town contains the text, names that start with it first. At most `max`.
export function searchClients(clients, text, max = 8) {
  const q = lower(text);
  if (!q) return [];

  return clients
    .filter((c) => lower(c.name).includes(q) || lower(c.city).includes(q))
    .sort((a, b) => Number(lower(b.name).startsWith(q)) - Number(lower(a.name).startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, max);
}

// Names counted case-insensitively; the most used first, then the one asked for most recently. Keeps the spelling used most often.
function ranked(names) {
  const seen = new Map();
  names.forEach((name, order) => {
    const key = lower(name);
    if (!key) return;
    const row = seen.get(key) ?? { count: 0, order, spellings: new Map() };
    row.count += 1;
    row.order = Math.min(row.order, order);
    row.spellings.set(name.trim(), (row.spellings.get(name.trim()) ?? 0) + 1);
    seen.set(key, row);
  });

  return [...seen.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map((row) => [...row.spellings].sort((a, b) => b[1] - a[1])[0][0]);
}

// The products the rep asked for before, most frequent first (newest enquiry first on a tie).
export function askedProducts(enquiries) {
  const newest = [...enquiries].sort((a, b) => stamp(b.updated_at ?? b.opened_at) - stamp(a.updated_at ?? a.opened_at));
  return ranked(newest.flatMap((e) => e.items.map((i) => i.product)));
}

// The brands the rep wrote for this product before (most used first).
export function askedBrands(enquiries, product) {
  const key = lower(product);
  if (!key) return [];

  const newest = [...enquiries].sort((a, b) => stamp(b.updated_at ?? b.opened_at) - stamp(a.updated_at ?? a.opened_at));
  return ranked(newest.flatMap((e) => e.items.filter((i) => lower(i.product) === key).flatMap((i) => splitBrands(i.brands))));
}

// The brands this rep writes most often, over all their enquiries (most used first): shown before any product is chosen.
export function frequentBrands(enquiries, limit = 8) {
  return ranked(enquiries.flatMap((e) => e.items.flatMap((i) => splitBrands(i.brands)))).slice(0, limit);
}

// "Remi, Labtech" <-> ['Remi', 'Labtech'] (the enquiry keeps one comma-separated text, as always)
export const splitBrands = (text) => [...new Map(String(text ?? '').split(',').map((b) => b.trim()).filter(Boolean).map((b) => [lower(b), b])).values()];
export const joinBrands = (list) => list.join(', ');

// The brands of the product guide for a product of the same name (premium, then economy, then lite).
export function guideBrands(products, product) {
  const key = lower(product);
  const match = key ? products.find((p) => lower(p.name) === key) : null;
  return match ? splitBrands([...(match.premium_brands ?? []), ...(match.economy_brands ?? []), ...(match.lite_brands ?? [])].join(',')) : [];
}

// The open enquiries of one client, newest first (so the form can warn about a double entry).
export function openEnquiriesOf(enquiries, clientId, exceptId = null) {
  if (!clientId) return [];
  return enquiries
    .filter((e) => e.client_id === clientId && e.id !== exceptId && isOpen(e.status))
    .sort((a, b) => stamp(b.updated_at ?? b.opened_at) - stamp(a.updated_at ?? a.opened_at));
}

// 340000 -> "₹3.4L", 50000 -> "₹50K", 12500000 -> "₹1.25Cr" (rupees in, Indian short form out)
export function shortMoney(rupees) {
  const value = Math.max(0, Number(rupees) || 0);
  const trim = (n) => String(Number(n.toFixed(2)));

  if (value < 1000) return `₹${Math.round(value)}`;

  const k = Number(trim(value / 1000));
  if (k < 100) return `₹${trim(value / 1000)}K`;

  const l = Number(trim(value / 100_000));
  if (l < 100) return `₹${trim(value / 100_000)}L`;

  return `₹${trim(value / 10_000_000)}Cr`;
}

// The budget box can hold at most 99,99,999 rupees (the same limit as the amount parser)
export const MAX_BUDGET_RUPEES = 9_999_999;

// A quick chip ADDS to what is typed: "1,00,000" + 100000 = "200000". Text in, plain text out (whole rupees, or with paise).
export function addBudget(current, add) {
  const text = String(current ?? '').replace(/,/g, '').trim();
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  const paise = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : 0;
  const sum = Math.min(paise + Math.round(add) * 100, MAX_BUDGET_RUPEES * 100);

  return sum % 100 === 0 ? String(sum / 100) : (sum / 100).toFixed(2).replace(/0$/, '');
}

// "300000" -> "3,00,000", "150000.5" -> "1,50,000.5" (Indian grouping, for when the box loses focus)
export function groupRupees(text) {
  const clean = String(text ?? '').replace(/,/g, '').trim();
  const match = /^(\d{1,7})(\.\d{0,2})?$/.exec(clean);
  if (!match) return String(text ?? '');

  const whole = match[1];
  const head = whole.length > 3 ? whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3) : whole;
  return head + (match[2] ?? '');
}
