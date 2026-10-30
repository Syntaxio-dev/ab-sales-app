import { normalizePhone } from '../core/phone.js';
import { CLIENT_TYPE_IDS } from '../core/guide.js';
import { isSource } from '../core/enquiry.js';
import { RESULTS, STATUSES as MEETING_STATUSES, validStartTime } from '../core/meeting.js';
import * as rules from '../core/rules.js';
import * as geo from '../core/geo.js';

// What the office sends back is NOT trusted blindly: every record is checked with the same rules as a record typed on the phone
// before it is stored (wrong types, huge texts, impossible dates are dropped). The screens also only ever show text as text.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['pending', 'approved', 'rejected'];

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const moment = (value) => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// -> a record in the phone's own shape, or null when it must be dropped
export function cleanExpense(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const updated = moment(r.updated_at);
  const error = rules.firstError(
    rules.CATEGORIES.includes(r.category) ? null : 'category',
    rules.amountPaise(r.amount_paise),
    /^\d{4}-\d{2}-\d{2}$/.test(r.expense_date ?? '') ? null : 'date',
    updated ? null : 'time',
    STATUSES.includes(r.status) ? null : 'status',
  );
  if (error) return null;

  const hasBill = r.has_bill === true;

  return {
    id: r.uuid,
    category: r.category,
    amount_paise: r.amount_paise,
    expense_date: r.expense_date,
    note: text(r.note, rules.MAX_NOTE),
    work_area: rules.WORK_AREAS.includes(r.work_area) ? r.work_area : null, // an expense from an older app has neither
    bill_type: rules.BILL_TYPES.includes(r.bill_type) ? r.bill_type : null,
    has_bill: hasBill,
    bill_synced: hasBill, // the office already holds the photo
    status: r.status,
    reviewed_at: moment(r.reviewed_at),
    reject_reason: r.reject_reason ? text(r.reject_reason, 500) : null,
    created_at: updated,
    updated_at: updated,
  };
}

// A saved spot from the office: both numbers valid or none (an office that does not know locations sends none).
function cleanSpot(lat, lng, accuracy) {
  const a = typeof lat === 'string' ? Number(lat) : lat;
  const b = typeof lng === 'string' ? Number(lng) : lng;
  if (!geo.validCoords(a, b)) return null;
  const acc = typeof accuracy === 'number' && geo.isAccuracy(accuracy) ? Math.round(accuracy) : null;
  return { lat: geo.round6(a), lng: geo.round6(b), accuracy: acc };
}

export function cleanClient(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const updated = moment(r.updated_at);
  const name = text(r.name, 150);
  if (!updated || name.length < 2) return null;

  return {
    id: r.uuid,
    name,
    company: text(r.company, 150),
    phone: normalizePhone(text(r.phone, 30)) ?? '', // one spelling, so a call can be matched to it
    city: text(r.city, 100),
    notes: text(r.notes, rules.MAX_NOTE),
    ...(() => {
      const spot = cleanSpot(r.lat, r.lng, r.location_accuracy_m);
      return { lat: spot?.lat ?? null, lng: spot?.lng ?? null, location_accuracy_m: spot?.accuracy ?? null, location_at: spot && r.location_at ? moment(r.location_at) : null };
    })(),
    // who added it / who works it: the office's, shown on the phone and never sent back
    assigned_to_code: r.assigned_to_code ? text(r.assigned_to_code, 30) : null,
    assigned_to_name: r.assigned_to_name ? text(r.assigned_to_name, 100) : null,
    created_by_code: r.created_by_code ? text(r.created_by_code, 30) : '', // '' = added by the office (not a rep)
    created_by_name: r.created_by_name ? text(r.created_by_name, 100) : null,
    created_at: updated,
    updated_at: updated,
  };
}

const ENQUIRY_STATUSES = ['new', 'price_to_send', 'price_sent', 'callback', 'meeting_planned', 'negotiation', 'won', 'lost'];

export function cleanEnquiry(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const updated = moment(r.updated_at);
  const opened = moment(r.opened_at);
  const client = text(r.client_name, 150);
  if (!updated || !opened || client.length < 2 || !ENQUIRY_STATUSES.includes(r.status) || !Array.isArray(r.items)) return null;

  const items = r.items.slice(0, 10).map((i) => ({
    product: text(i?.product, 150),
    brands: text(i?.brands, 150),
    quantity: Number.isInteger(i?.quantity) && i.quantity >= 1 && i.quantity <= 100_000 ? i.quantity : 1,
    budget_paise: Number.isInteger(i?.budget_paise) && i.budget_paise >= 0 && i.budget_paise <= 100_000_000_000 ? i.budget_paise : null,
  })).filter((i) => i.product.length >= 2);
  if (!items.length) return null;

  const timeline = (Array.isArray(r.timeline) ? r.timeline : []).slice(-100)
    .map((t) => ({ at: moment(t?.at), text: text(t?.text, 500), status: ENQUIRY_STATUSES.includes(t?.status) ? t.status : null }))
    .filter((t) => t.at);

  return {
    id: r.uuid,
    client_id: typeof r.client_uuid === 'string' && UUID.test(r.client_uuid) ? r.client_uuid : null,
    client_name: client,
    contact_id: typeof r.contact_uuid === 'string' && UUID.test(r.contact_uuid) ? r.contact_uuid : null,
    contact_name: text(r.contact_name, 150),
    status: r.status,
    source: isSource(r.source) ? r.source : null, // an office that does not know the field sends none
    items,
    opened_at: opened,
    next_followup_at: r.next_followup_at ? moment(r.next_followup_at) : null,
    closed_at: r.closed_at ? moment(r.closed_at) : null,
    timeline,
    created_at: opened,
    updated_at: updated,
  };
}

export function cleanReport(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const updated = moment(r.updated_at);
  if (!updated || !/^\d{4}-\d{2}-\d{2}$/.test(r.report_date ?? '')) return null;

  const figures = {};
  for (const key of ['calls', 'calls_missed', 'talk_seconds', 'meetings', 'enquiries_new', 'enquiries_worked', 'expenses_paise']) {
    figures[key] = Number.isInteger(r.figures?.[key]) && r.figures[key] >= 0 ? r.figures[key] : 0;
  }

  return {
    id: r.uuid,
    report_date: r.report_date,
    notes: text(r.notes, rules.MAX_LONG_TEXT),
    tomorrow_plan: text(r.tomorrow_plan, rules.MAX_NOTE),
    issues: text(r.issues, rules.MAX_NOTE),
    figures,
    submitted_at: r.submitted_at ? moment(r.submitted_at) : null,
    created_at: updated,
    updated_at: updated,
  };
}

export function cleanContact(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const updated = moment(r.updated_at);
  const name = text(r.name, 150);
  const hasClient = typeof r.client_uuid === 'string' && UUID.test(r.client_uuid);
  if (!updated || name.length < 2 || (r.client_uuid != null && !hasClient)) return null; // no client_uuid = a person without a company

  return {
    id: r.uuid,
    client_id: hasClient ? r.client_uuid : null,
    name,
    position: text(r.position, 100),
    phone: normalizePhone(text(r.phone, 30)) ?? '',
    email: text(r.email, 150),
    notes: text(r.notes, rules.MAX_NOTE),
    created_by_code: r.created_by_code ? text(r.created_by_code, 30) : '', // '' = added by the office (not a rep)
    created_by_name: r.created_by_name ? text(r.created_by_name, 100) : null,
    created_at: updated,
    updated_at: updated,
  };
}

// A call log row of this rep (a new phone gets its own history back). The office never changes one.
export function cleanCall(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const started = moment(r.started_at);
  if (!started || !['incoming', 'outgoing', 'missed'].includes(r.direction)) return null;
  if (typeof r.number !== 'string' || !/^\+[0-9]{8,15}$/.test(r.number)) return null;
  if (!Number.isInteger(r.duration_seconds) || r.duration_seconds < 0 || r.duration_seconds > 86_400) return null;

  const updated = moment(r.updated_at) ?? started;

  return {
    id: r.uuid,
    direction: r.direction,
    number: r.number,
    client_id: typeof r.client_uuid === 'string' && UUID.test(r.client_uuid) ? r.client_uuid : null,
    contact_id: typeof r.contact_uuid === 'string' && UUID.test(r.contact_uuid) ? r.contact_uuid : null,
    client_name: text(r.client_name, 150),
    contact_name: text(r.contact_name, 150),
    started_at: started,
    duration_seconds: r.duration_seconds,
    created_at: updated,
    updated_at: updated,
  };
}

export function cleanMeeting(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const updated = moment(r.updated_at);
  const at = moment(r.meeting_at);
  const name = text(r.client_name, 150);
  if (!updated || !at || !name) return null;

  const followup = r.next_followup_at ? moment(r.next_followup_at) : null;

  return {
    id: r.uuid,
    client_id: typeof r.client_uuid === 'string' && UUID.test(r.client_uuid) ? r.client_uuid : null,
    client_name: name,
    contact_ids: Array.isArray(r.contact_uuids) ? r.contact_uuids.filter((c) => typeof c === 'string' && UUID.test(c)).slice(0, 20) : [],
    meeting_at: at,
    purpose: text(r.purpose, rules.MAX_TEXT),
    discussion: text(r.discussion, rules.MAX_LONG_TEXT),
    outcome: text(r.outcome, rules.MAX_TEXT),
    next_followup_at: followup,
    // planning fields (an office that does not know them sends none: the meeting is then an ordinary, logged one)
    status: MEETING_STATUSES.includes(r.status) ? r.status : 'done',
    scheduled_at: r.scheduled_at ? moment(r.scheduled_at) : null,
    ended_at: r.ended_at ? moment(r.ended_at) : null,
    route_id: typeof r.route_uuid === 'string' && UUID.test(r.route_uuid) ? r.route_uuid : null,
    result: RESULTS.some((x) => x.value === r.result) ? r.result : null,
    moved_from: r.moved_from ? moment(r.moved_from) : null,
    time_manual: r.time_manual === true,
    // check-in with a selfie (an office that does not know it sends none)
    ...(() => {
      const spot = r.checkin_at ? cleanSpot(r.checkin_lat, r.checkin_lng, r.checkin_accuracy_m) : null;
      const dist = spot && Number.isFinite(r.checkin_distance_m) && r.checkin_distance_m >= 0 ? Math.round(r.checkin_distance_m) : null;
      return {
        checkin_at: spot ? moment(r.checkin_at) : null,
        checkin_lat: spot?.lat ?? null,
        checkin_lng: spot?.lng ?? null,
        checkin_accuracy_m: spot?.accuracy ?? null,
        checkin_distance_m: dist,
        has_selfie: Boolean(spot) && r.has_selfie === true,
        selfie_synced: Boolean(spot) && r.has_selfie === true,
      };
    })(),
    created_at: updated,
    updated_at: updated,
  };
}

// A route: the stops of one day, one rep (the office only ever sends a rep their own).
export function cleanRoute(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const updated = moment(r.updated_at);
  const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
  const order = Array.isArray(r.stops_order) ? [...new Set(r.stops_order.filter((s) => typeof s === 'string' && UUID.test(s)))].slice(0, 10) : [];
  if (!updated || !date || !order.length) return null;

  return {
    id: r.uuid,
    rep_id: null,
    date,
    title: text(r.title, 60) || 'Route',
    area: text(r.area, 100),
    start_time: validStartTime(r.start_time) ? r.start_time : '09:00',
    overnight: r.overnight === true,
    stops_order: order,
    created_at: updated,
    updated_at: updated,
  };
}

// ---- the product guide (read only on the phone) ----

const lines = (value, maxItems, maxLength) => (Array.isArray(value)
  ? value.filter((s) => typeof s === 'string').map((s) => s.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems)
  : []);

export function cleanProduct(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const name = text(r.name, 200);
  if (name.length < 2) return null;

  const pairs = (value, max, keyA, keyB, lenA, lenB) => (Array.isArray(value)
    ? value.map((v) => ({ [keyA]: text(v?.[keyA], lenA), [keyB]: text(v?.[keyB], lenB) })).slice(0, max)
    : []);

  return {
    id: r.uuid,
    name,
    group: text(r.group, 100),
    sort: Number.isInteger(r.sort) && r.sort >= 0 && r.sort <= 65_000 ? r.sort : 0,
    premium_brands: lines(r.premium_brands, 30, 100),
    economy_brands: lines(r.economy_brands, 30, 100),
    lite_brands: lines(r.lite_brands, 30, 100),
    summary: text(r.summary, 6000),
    variants: pairs(r.variants, 20, 'name', 'text', 200, 2000).filter((v) => v.text),
    industries: text(r.industries, 2000),
    key_parameters: lines(r.key_parameters, 40, 1000),
    short_term_problems: lines(r.short_term_problems, 40, 1000),
    long_term_problems: lines(r.long_term_problems, 40, 1000),
    top_brands: pairs(r.top_brands, 20, 'name', 'note', 150, 1000).filter((b) => b.name),
    // "before the meeting" (all optional; an office without them sends nothing)
    client_types: Array.isArray(r.client_types) ? [...new Set(r.client_types.filter((t) => CLIENT_TYPE_IDS.includes(t)))] : [],
    pitch: text(r.pitch, 600),
    key_notes: lines(r.key_notes, 5, 200),
    formula: text(r.formula, 300),
    do: lines(r.do, 3, 160),
    avoid: lines(r.avoid, 3, 160),
    match_rules: pairs(r.match_rules, 4, 'if', 'then', 200, 100).filter((m) => m.if && m.then),
  };
}

// A rep's own script (private; it comes back on a new phone).
export function cleanScript(r) {
  if (!r || typeof r.uuid !== 'string' || !UUID.test(r.uuid)) return null;

  const updated = moment(r.updated_at);
  const body = text(r.body, 3000);
  const name = text(r.product_name, 200);
  if (!updated || body.length < 3 || name.length < 2) return null;

  return {
    id: r.uuid,
    product_id: typeof r.product_uuid === 'string' && UUID.test(r.product_uuid) ? r.product_uuid : null,
    product_name: name,
    title: text(r.title, 120),
    body,
    created_at: updated,
    updated_at: updated,
  };
}

// The whole guide from the office -> { version, products } (a broken product is dropped, the rest is kept), or null when it is no guide at all.
export function cleanGuide(answer) {
  if (!answer || typeof answer.version !== 'string' || !Array.isArray(answer.products)) return null;

  const seen = new Set();
  const products = [];
  for (const raw of answer.products.slice(0, 500)) {
    const product = cleanProduct(raw);
    if (product && !seen.has(product.id)) {
      seen.add(product.id);
      products.push(product);
    }
  }

  return { version: answer.version.slice(0, 40), products };
}

// A request for a guide note only ever goes from the phone to the office: nothing comes back to be merged.
export const CLEANERS = { expense: cleanExpense, client: cleanClient, contact: cleanContact, meeting: cleanMeeting, route: cleanRoute, enquiry: cleanEnquiry, call: cleanCall, report: cleanReport, note: () => null, script: cleanScript };

// What to do with a record the office sent, given what the phone has:
//  'create'  the phone does not have it (a new phone, or a restore)
//  'replace' the office's version wins
//  'keep'    the phone's version stays
// Rules: the office's DECISION on an expense always wins; changes made on the phone that were not sent yet win over an
// older office copy (the next push sends them); otherwise the newer of the two wins.
export function decide(kind, local, server) {
  if (!local) return 'create';
  if (kind === 'expense' && server.status !== 'pending') return 'replace';
  if (kind === 'call') return 'keep'; // a call never changes
  if (!local.synced) return 'keep';

  return Date.parse(server.updated_at) > Date.parse(local.updated_at) ? 'replace' : 'keep';
}

// A phone that took the photo but has not uploaded it yet must not lose the flag when the office copy (no photo yet) replaces it.
// Same for a selfie taken on the phone but not uploaded yet, and for a check-in the office has not heard about.
export function keepPendingCheckin(local, cleaned) {
  if (local?.checkin_at && !cleaned.checkin_at) {
    const keep = ['checkin_at', 'checkin_lat', 'checkin_lng', 'checkin_accuracy_m', 'checkin_distance_m', 'has_selfie', 'selfie_synced'];
    return { ...cleaned, ...Object.fromEntries(keep.map((k) => [k, local[k]])) };
  }
  if (local?.has_selfie && !local.selfie_synced && cleaned.checkin_at && !cleaned.has_selfie) return { ...cleaned, has_selfie: true, selfie_synced: false };
  return cleaned;
}

export function keepPendingBill(local, cleaned) {
  if (local?.has_bill && !cleaned.has_bill) return { ...cleaned, has_bill: true, bill_synced: local.bill_synced };
  return cleaned;
}
