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

const PREFIX = { expense: 'e:', client: 'c:', meeting: 'm:', bill: 'b:' };
const PROFILE_KEY = 'profile';

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
  #expenses = new Map();
  #clients = new Map();
  #meetings = new Map();
  #profile = null;

  constructor(persist, key) {
    this.#persist = persist;
    this.#key = key;
  }

  // Reads and decrypts everything. A record that cannot be read is skipped: one bad record never hides the others.
  static async open(persist, key) {
    const store = new Store(persist, key);

    for (const [kind, map] of [['expense', store.#expenses], ['client', store.#clients], ['meeting', store.#meetings]]) {
      for (const slot of await persist.keys(PREFIX[kind])) {
        const record = await store.#read(slot);
        if (record?.id) map.set(record.id, record);
      }
    }
    store.#profile = await store.#read(PROFILE_KEY);

    return store;
  }

  async close() {
    this.#open = false;
    this.#key = null;
    this.#expenses.clear();
    this.#clients.clear();
    this.#meetings.clear();
    this.#profile = null;
    this.#listeners.clear();
  }

  // Calls `listener` after every change; returns the function that stops it.
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
      status: old?.status ?? 'pending',
      synced: false,
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

  async deleteExpense(id) {
    await this.#persist.del(PREFIX.expense + id);
    await this.#persist.del(PREFIX.bill + id);
    this.#expenses.delete(id);
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
    this.#changed();
  }

  // ---- export ----------------------------------------------------------------

  // How many records are still only on this phone (nothing is sent anywhere in version 1).
  get unsyncedCount() {
    return [...this.#expenses.values(), ...this.#clients.values(), ...this.#meetings.values()].filter((r) => !r.synced).length;
  }

  // Everything as one JSON document (bill photos are not included). Field names are the ones the office server will use.
  exportAll() {
    const strip = (r) => ({ uuid: r.id, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id')) });

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

  #changed() {
    for (const listener of [...this.#listeners]) listener();
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
