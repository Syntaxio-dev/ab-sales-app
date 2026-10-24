import * as rules from '../core/rules.js';

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
    has_bill: hasBill,
    bill_synced: hasBill, // the office already holds the photo
    status: r.status,
    reviewed_at: moment(r.reviewed_at),
    reject_reason: r.reject_reason ? text(r.reject_reason, 500) : null,
    created_at: updated,
    updated_at: updated,
  };
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
    phone: text(r.phone, 30),
    city: text(r.city, 100),
    notes: text(r.notes, rules.MAX_NOTE),
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
    meeting_at: at,
    purpose: text(r.purpose, rules.MAX_TEXT),
    discussion: text(r.discussion, rules.MAX_LONG_TEXT),
    outcome: text(r.outcome, rules.MAX_TEXT),
    next_followup_at: followup,
    created_at: updated,
    updated_at: updated,
  };
}

export const CLEANERS = { expense: cleanExpense, client: cleanClient, meeting: cleanMeeting };

// What to do with a record the office sent, given what the phone has:
//  'create'  the phone does not have it (a new phone, or a restore)
//  'replace' the office's version wins
//  'keep'    the phone's version stays
// Rules: the office's DECISION on an expense always wins; changes made on the phone that were not sent yet win over an
// older office copy (the next push sends them); otherwise the newer of the two wins.
export function decide(kind, local, server) {
  if (!local) return 'create';
  if (kind === 'expense' && server.status !== 'pending') return 'replace';
  if (!local.synced) return 'keep';

  return Date.parse(server.updated_at) > Date.parse(local.updated_at) ? 'replace' : 'keep';
}

// A phone that took the photo but has not uploaded it yet must not lose the flag when the office copy (no photo yet) replaces it.
export function keepPendingBill(local, cleaned) {
  if (local?.has_bill && !cleaned.has_bill) return { ...cleaned, has_bill: true, bill_synced: local.bill_synced };
  return cleaned;
}
