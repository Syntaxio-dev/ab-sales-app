import * as rules from '../core/rules.js';
import { normalizePhone } from '../core/phone.js';
import { fromBase64, fromUtf8, open, seal, toBase64, utf8 } from '../security/crypto.js';

// All of the rep's data. Every record is encrypted (AES-256-GCM) before it reaches the disk, and its storage slot
// is part of what is authenticated, so a record moved to another slot is refused. While the app is unlocked the
// decrypted records live in memory (they are small); close() drops them again.
//
// Records carry a client-made UUID (a later sync can never create the same record twice), a `synced` flag, and times
// in UTC. Money is whole paise (an integer), never a float. Every save checks the rules again, so a bug in a screen
// cannot store a bad record.

export class ValidationError extends Error {}

const PREFIX = { expense: 'e:', client: 'c:', meeting: 'm:', bill: 'b:', tomb: 't:' };
const PROFILE_KEY = 'profile';
const SYNC_KEY = 'sync';
const KINDS = ['expense', 'client', 'meeting'];

// UPDATES KEEP THE DATA. Phones that already hold records get a newer app over the old one, so a newer version must be able
// to read every record an older version wrote. The rules (the same idea as Prysm's normalize()):
//  - never rename, remove or change the meaning of a stored field; only ADD fields;
//  - give every new field a default here, so an old record that lacks it still loads;
//  - tests/compat.test.js holds real v1.0 records and must keep passing unchanged.
const DEFAULTS = {
  expense: { note: '', has_bill: false, bill_synced: false, status: 'pending', synced: false, sync_error: null, reviewed_at: null, reject_reason: null },
  client: { company: '', phone: '', city: '', notes: '', synced: false, sync_error: null },
  meeting: { client_id: null, purpose: '', discussion: '', outcome: '', next_followup_at: null, synced: false, sync_error: null },
};

// Every method that changes data. They run ONE AT A TIME, in the order they were called: a save made while the sync is
// bookkeeping the same record can then never be overwritten by an older copy (two writes finishing in the wrong order).
const MUTATORS = [
  'saveProfile', 'saveExpense', 'deleteExpense', 'saveClient', 'deleteClient', 'saveMeeting', 'deleteMeeting',
  'saveSyncState', 'clearTombstone', 'markSynced', 'markRefused', 'markBillSynced',
  'putFromServer', 'removeFromServer', 'saveBillFromServer',
];

const nowIso = () => new Date().toISOString();
const check = (...errors) => {
  const error = rules.firstError(...errors);
  if (error) throw new ValidationError(error);
};

export class Store {
  #persist;
  #key;
  #open = true;
  #listeners = new Set();
  #userListeners = new Set();
  #tombs = new Map();
  #sync = null;
  #expenses = new Map();
  #clients = new Map();
  #meetings = new Map();
  #profile = null;

  #queue = Promise.resolve();

  constructor(persist, key) {
    this.#persist = persist;
    this.#key = key;

    for (const name of MUTATORS) {
      const original = this[name];
      this[name] = (...args) => this.#exclusive(() => original.apply(this, args));
    }
  }

  #exclusive(work) {
    const run = this.#queue.then(work);
    this.#queue = run.then(() => undefined, () => undefined); // one failed save must not block the next one
    return run;
  }

  // Reads and decrypts everything. A record that cannot be read is skipped: one bad record never hides the others.
  static async open(persist, key) {
    const store = new Store(persist, key);

    for (const [kind, map] of [['expense', store.#expenses], ['client', store.#clients], ['meeting', store.#meetings]]) {
      for (const slot of await persist.keys(PREFIX[kind])) {
        const record = await store.#read(slot);
        if (record?.id) map.set(record.id, { ...DEFAULTS[kind], ...record });
      }
    }
    store.#profile = await store.#read(PROFILE_KEY);
    store.#sync = await store.#read(SYNC_KEY);

    for (const slot of await persist.keys(PREFIX.tomb)) {
      const tomb = await store.#read(slot);
      if (tomb?.kind && tomb?.id) store.#tombs.set(`${tomb.kind}:${tomb.id}`, tomb);
    }

    return store;
  }

  async close() {
    this.#open = false;
    this.#key = null;
    this.#expenses.clear();
    this.#clients.clear();
    this.#meetings.clear();
    this.#profile = null;
    this.#sync = null;
    this.#tombs.clear();
    this.#listeners.clear();
    this.#userListeners.clear();
  }

  // Calls `listener` after every change (the screens redraw); returns the function that stops it.
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Calls `listener` only after a change made by the person (a save or a delete), not after the sync's own bookkeeping.
  // This is what starts an automatic sync.
  onUserChange(listener) {
    this.#userListeners.add(listener);
    return () => this.#userListeners.delete(listener);
  }

  // ---- profile ---------------------------------------------------------------

  get profile() {
    return this.#profile ? { ...this.#profile } : null;
  }

  async saveProfile({ name, employeeCode }) {
    check(rules.required(name, { min: 2, max: 100, label: 'Name' }), rules.employeeCode(employeeCode));

    this.#profile = { name: name.trim(), employee_code: employeeCode.trim().toUpperCase() };
    await this.#write(PROFILE_KEY, this.#profile);
    this.#changed();
  }

  // ---- expenses --------------------------------------------------------------

  // Newest day first.
  get expenses() {
    return [...this.#expenses.values()].sort((a, b) => b.expense_date.localeCompare(a.expense_date) || b.created_at.localeCompare(a.created_at));
  }

  // input: { id?, category, amount_paise, expense_date: 'YYYY-MM-DD', note }
  // bill: Uint8Array of a new photo, or null. removeBill: delete the stored photo. With neither, the photo stays.
  async saveExpense(input, { bill = null, removeBill = false } = {}) {
    check(
      rules.expenseDate(input.expense_date),
      rules.CATEGORIES.includes(input.category) ? null : 'Pick a category.',
      rules.amountPaise(input.amount_paise),
      rules.optional(input.note, { max: rules.MAX_NOTE, label: 'Note' }),
      bill && !rules.imageKind(bill) ? 'Please use a JPG, PNG or WebP picture.' : null,
      bill && bill.length > rules.MAX_BILL_BYTES ? 'The picture is bigger than 5 MB.' : null,
    );

    const id = input.id ?? crypto.randomUUID();
    const old = this.#expenses.get(id);

    // Once the office has decided, the expense is final on the phone too (the server refuses changes anyway).
    if (old && old.status !== 'pending') throw new ValidationError('The office already reviewed this expense, so it cannot be changed.');

    if (bill) await this.#writeBytes(PREFIX.bill + id, bill);
    if (removeBill) await this.#persist.del(PREFIX.bill + id);
    const hasBill = (await this.#persist.get(PREFIX.bill + id)) !== null;

    // status is never taken from the caller: only the office changes it (later, through sync)
    const record = {
      id,
      category: input.category,
      amount_paise: input.amount_paise,
      expense_date: input.expense_date,
      note: String(input.note ?? '').trim(),
      has_bill: hasBill,
      // a new photo has to be uploaded; with no photo there is nothing to upload
      bill_synced: bill ? false : removeBill ? true : (old?.bill_synced ?? false),
      status: old?.status ?? 'pending',
      reviewed_at: old?.reviewed_at ?? null,
      reject_reason: old?.reject_reason ?? null,
      synced: false,
      sync_error: null,
      created_at: old?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };

    await this.#write(PREFIX.expense + id, record);
    this.#expenses.set(id, record);
    this.#changed();
    return record;
  }

  async billFor(expenseId) {
    return this.#readBytes(PREFIX.bill + expenseId);
  }

  // Is the photo on the phone? (a cheap check: nothing is decrypted)
  async hasBillData(expenseId) {
    this.#assertOpen();
    return (await this.#persist.get(PREFIX.bill + expenseId)) !== null;
  }

  async deleteExpense(id) {
    const old = this.#expenses.get(id);
    if (old && old.status !== 'pending') throw new ValidationError('The office already reviewed this expense, so it cannot be deleted.');

    await this.#persist.del(PREFIX.expense + id);
    await this.#persist.del(PREFIX.bill + id);
    this.#expenses.delete(id);
    await this.#remember('expense', id);
    this.#changed();
  }

  // ---- clients ---------------------------------------------------------------

  get clients() {
    return [...this.#clients.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  clientById(id) {
    return (id && this.#clients.get(id)) || null;
  }

  // input: { id?, name, company, phone, city, notes }
  async saveClient(input) {
    check(
      rules.required(input.name, { min: 2, max: 150, label: 'Name' }),
      rules.optional(input.company, { max: 150, label: 'Company' }),
      rules.phone(input.phone),
      rules.optional(input.city, { max: 100, label: 'City' }),
      rules.optional(input.notes, { max: rules.MAX_NOTE, label: 'Notes' }),
    );

    const id = input.id ?? crypto.randomUUID();
    const old = this.#clients.get(id);
    const record = {
      id,
      name: input.name.trim(),
      company: String(input.company ?? '').trim(),
      phone: normalizePhone(input.phone) ?? '',
      city: String(input.city ?? '').trim(),
      notes: String(input.notes ?? '').trim(),
      synced: false,
      sync_error: null,
      created_at: old?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };

    await this.#write(PREFIX.client + id, record);
    this.#clients.set(id, record);
    this.#changed();
    return record;
  }

  // Meetings keep the client's name (a copy), so deleting a client loses nothing.
  async deleteClient(id) {
    await this.#persist.del(PREFIX.client + id);
    this.#clients.delete(id);
    await this.#remember('client', id);
    this.#changed();
  }

  // ---- meetings --------------------------------------------------------------

  // Newest meeting first.
  get meetings() {
    return [...this.#meetings.values()].sort((a, b) => b.meeting_at.localeCompare(a.meeting_at));
  }

  // input: { id?, client_id, client_name, meeting_at (ISO), purpose, discussion, outcome, next_followup_at (ISO|null) }
  async saveMeeting(input) {
    const at = Date.parse(input.meeting_at);
    const followup = input.next_followup_at ? Date.parse(input.next_followup_at) : null;

    check(
      Number.isNaN(at) ? 'Pick the meeting time.' : null,
      rules.required(input.client_name, { max: 150, label: 'Client name' }),
      rules.optional(input.purpose, { max: rules.MAX_TEXT, label: 'Purpose' }),
      rules.optional(input.discussion, { max: rules.MAX_LONG_TEXT, label: 'Discussion' }),
      rules.optional(input.outcome, { max: rules.MAX_TEXT, label: 'Outcome' }),
      followup !== null && (Number.isNaN(followup) || followup < at) ? 'Follow-up must be after the meeting.' : null,
    );

    const id = input.id ?? crypto.randomUUID();
    const old = this.#meetings.get(id);
    const record = {
      id,
      client_id: input.client_id ?? null,
      client_name: input.client_name.trim(),
      meeting_at: new Date(at).toISOString(),
      purpose: String(input.purpose ?? '').trim(),
      discussion: String(input.discussion ?? '').trim(),
      outcome: String(input.outcome ?? '').trim(),
      next_followup_at: followup === null ? null : new Date(followup).toISOString(),
      synced: false,
      sync_error: null,
      created_at: old?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };

    await this.#write(PREFIX.meeting + id, record);
    this.#meetings.set(id, record);
    this.#changed();
    return record;
  }

  async deleteMeeting(id) {
    await this.#persist.del(PREFIX.meeting + id);
    this.#meetings.delete(id);
    await this.#remember('meeting', id);
    this.#changed();
  }

  // ---- sync (used by src/sync/engine.js) ---------------------------------------------------

  // What the office link remembers (encrypted like everything else): { linked, token, expires_at, account, cursor, last_sync_at, last_error }.
  get syncState() {
    return this.#sync ? { ...this.#sync } : null;
  }

  async saveSyncState(patch) {
    this.#sync = { ...(this.#sync ?? {}), ...patch };
    await this.#write(SYNC_KEY, this.#sync);
  }

  #map(kind) {
    return { expense: this.#expenses, client: this.#clients, meeting: this.#meetings }[kind];
  }

  getRecord(kind, id) {
    const record = this.#map(kind)?.get(id);
    return record ? { ...record } : null;
  }

  // Records that changed on this phone and still have to be sent (a record the office refused is not sent again until it is edited).
  dirty(kind) {
    return [...this.#map(kind).values()].filter((r) => !r.synced && !r.sync_error).map((r) => ({ ...r }));
  }

  // Deletes the office has not heard about yet: [{ kind, id, at }].
  get tombstones() {
    return [...this.#tombs.values()];
  }

  async clearTombstone(kind, id) {
    this.#tombs.delete(`${kind}:${id}`);
    await this.#persist.del(`${PREFIX.tomb}${kind}:${id}`);
  }

  // The office accepted this version of the record. If it was edited again while the push was on its way, it stays "not sent".
  async markSynced(kind, id, updatedAt) {
    const record = this.#map(kind).get(id);
    if (!record || record.updated_at !== updatedAt) return;

    await this.#put(kind, { ...record, synced: true, sync_error: null });
  }

  // The office refused this record (it breaks a rule there): keep it, say why, and stop sending it until it is edited.
  async markRefused(kind, id, updatedAt, message) {
    const record = this.#map(kind).get(id);
    if (!record || record.updated_at !== updatedAt) return;

    await this.#put(kind, { ...record, synced: false, sync_error: String(message ?? 'Not accepted by the office.').slice(0, 300) });
  }

  async markBillSynced(id) {
    const record = this.#expenses.get(id);
    if (record) await this.#put('expense', { ...record, bill_synced: true });
  }

  // A record that came FROM the office (already checked by src/sync/merge.js): stored as "sent".
  async putFromServer(kind, record, bill = null) {
    await this.#put(kind, { ...DEFAULTS[kind], ...record, synced: true, sync_error: null });
    if (bill) await this.#writeBytes(PREFIX.bill + record.id, bill);
  }

  async removeFromServer(kind, id) {
    await this.#persist.del(PREFIX[kind] + id);
    if (kind === 'expense') await this.#persist.del(PREFIX.bill + id);
    this.#map(kind).delete(id);
    this.#changed(false);
  }

  async saveBillFromServer(id, bytes) {
    const record = this.#expenses.get(id);
    if (!record) return;

    await this.#writeBytes(PREFIX.bill + id, bytes);
    await this.#put('expense', { ...record, has_bill: true, bill_synced: true });
  }

  // ---- export ----------------------------------------------------------------

  // How many changes are still only on this phone: records not sent yet, and deletes the office has not heard of.
  get unsyncedCount() {
    return KINDS.reduce((sum, kind) => sum + this.dirty(kind).length, 0) + this.#tombs.size;
  }

  // Records the office refused (they break one of its rules).
  get refused() {
    return KINDS.flatMap((kind) => [...this.#map(kind).values()].filter((r) => r.sync_error).map((r) => ({ kind, id: r.id, message: r.sync_error })));
  }

  // Everything as one JSON document (bill photos are not included). Field names are the ones the office server will use.
  exportAll() {
    const strip = (r) => ({ uuid: r.id, ...Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'bill_synced', 'sync_error'].includes(k))) });

    return {
      format: 'ab-sales-export',
      version: 1,
      exported_at: nowIso(),
      rep: this.profile,
      expenses: this.expenses.map(strip),
      clients: this.clients.map(strip),
      meetings: this.meetings.map(strip),
    };
  }

  // ---- internals -------------------------------------------------------------

  // fromUser: false for the sync's own bookkeeping (screens still redraw, but no new sync is started by it)
  #changed(fromUser = true) {
    for (const listener of [...this.#listeners]) listener();
    if (fromUser) for (const listener of [...this.#userListeners]) listener();
  }

  async #put(kind, record) {
    await this.#write(PREFIX[kind] + record.id, record);
    this.#map(kind).set(record.id, record);
    this.#changed(false);
  }

  // A delete is remembered (until the office has heard of it) only once the phone is linked to an office account.
  async #remember(kind, id) {
    if (!this.#sync?.linked) return;

    const tomb = { kind, id, at: nowIso() };
    await this.#write(`${PREFIX.tomb}${kind}:${id}`, tomb);
    this.#tombs.set(`${kind}:${id}`, tomb);
  }

  #assertOpen() {
    if (!this.#open) throw new Error('The app is locked.');
  }

  async #write(slot, value) {
    await this.#writeBytes(slot, utf8(JSON.stringify(value)));
  }

  async #writeBytes(slot, bytes) {
    this.#assertOpen();
    await this.#persist.set(slot, toBase64(await seal(this.#key, bytes, slot)));
  }

  async #read(slot) {
    const bytes = await this.#readBytes(slot);
    if (!bytes) return null;

    try {
      return JSON.parse(fromUtf8(bytes));
    } catch {
      return null;
    }
  }

  async #readBytes(slot) {
    this.#assertOpen();
    const text = await this.#persist.get(slot);
    if (text === null) return null;

    try {
      return await open(this.#key, fromBase64(text), slot);
    } catch {
      return null; // damaged, changed, or moved to another slot
    }
  }
}
