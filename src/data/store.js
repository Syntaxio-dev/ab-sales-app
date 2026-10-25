import * as rules from '../core/rules.js';
import { normalizePhone } from '../core/phone.js';
import * as enquiryRules from '../core/enquiry.js';
import { CLIENT_TYPE_IDS, withGuideDefaults } from '../core/guide.js';
import { PRESET_POSITIONS, cleanPosition, positionKey } from '../core/positions.js';
import { fromBase64, fromUtf8, open, seal, toBase64, utf8 } from '../security/crypto.js';

// All of the rep's data. Every record is encrypted (AES-256-GCM) before it reaches the disk, and its storage slot
// is part of what is authenticated, so a record moved to another slot is refused. While the app is unlocked the
// decrypted records live in memory (they are small); close() drops them again.
//
// Records carry a client-made UUID (a later sync can never create the same record twice), a `synced` flag, and times
// in UTC. Money is whole paise (an integer), never a float. Every save checks the rules again, so a bug in a screen
// cannot store a bad record.

export class ValidationError extends Error {}

const PREFIX = { expense: 'e:', client: 'c:', contact: 'p:', meeting: 'm:', enquiry: 'q:', call: 'l:', report: 'r:', note: 'n:', script: 's:', bill: 'b:', tomb: 't:' };
const PROFILE_KEY = 'profile';
const SYNC_KEY = 'sync';
const PREFS_KEY = 'prefs';
const POSITIONS_KEY = 'positions';
const GUIDE_KEY = 'guide'; // the product guide (written by the manager; this phone only reads it)
const PROGRESS_KEY = 'guideprogress'; // the rep's own place in the guide: ticks, learned products, last client type (ids and booleans only)
// the order the records are sent in: a client before the people at it
const KINDS = ['expense', 'client', 'contact', 'meeting', 'enquiry', 'call', 'report', 'note', 'script'];
const MAX_NOTES_KEPT = 60; // requests for a guide note that were sent are kept as a short history

// UPDATES KEEP THE DATA. Phones that already hold records get a newer app over the old one, so a newer version must be able
// to read every record an older version wrote. The rules (the same idea as Prysm's normalize()):
//  - never rename, remove or change the meaning of a stored field; only ADD fields;
//  - give every new field a default here, so an old record that lacks it still loads;
//  - tests/compat.test.js holds real v1.0 records and must keep passing unchanged.
const DEFAULTS = {
  expense: { note: '', bill_type: null, work_area: null, has_bill: false, bill_synced: false, status: 'pending', synced: false, sync_error: null, reviewed_at: null, reject_reason: null },
  // assigned_to_* and created_by_* are the office's: the phone shows them and never changes them
  client: { company: '', phone: '', city: '', notes: '', assigned_to_code: null, assigned_to_name: null, created_by_code: null, created_by_name: null, synced: false, sync_error: null },
  contact: { client_id: null, position: '', phone: '', email: '', notes: '', created_by_code: null, created_by_name: null, synced: false, sync_error: null },
  meeting: { client_id: null, contact_ids: [], purpose: '', discussion: '', outcome: '', next_followup_at: null, synced: false, sync_error: null },
  call: { direction: 'outgoing', number: '', client_id: null, contact_id: null, client_name: '', contact_name: '', duration_seconds: 0, synced: false, sync_error: null },
  enquiry: { client_id: null, client_name: '', contact_id: null, contact_name: '', status: 'new', items: [], next_followup_at: null, closed_at: null, timeline: [], synced: false, sync_error: null },
  report: { notes: '', tomorrow_plan: '', issues: '', figures: {}, submitted_at: null, synced: false, sync_error: null },
  // a rep's request to the manager: "please add / correct this in the product guide"
  note: { product_id: null, product_name: '', body: '', synced: false, sync_error: null },
  // a rep's own pitch for a product (private to the rep, kept at the office so a new phone gets it back)
  script: { product_id: null, product_name: '', title: '', body: '', synced: false, sync_error: null },
};

const MAX_PEOPLE_PER_MEETING = 20;
const TWO_YEARS = 2 * 365 * 86_400_000; // the office refuses a follow-up further ahead than this

// Every method that changes data. They run ONE AT A TIME, in the order they were called: a save made while the sync is
// bookkeeping the same record can then never be overwritten by an older copy (two writes finishing in the wrong order).
const MUTATORS = [
  'saveProfile', 'saveExpense', 'deleteExpense', 'saveClient', 'deleteClient', 'saveContact', 'deleteContact', 'saveMeeting', 'deleteMeeting',
  'saveEnquiry', 'deleteEnquiry', 'saveReport', 'saveCalls', 'savePrefs', 'addPosition', 'setPositionsFromServer', 'clearPendingPositions',
  'saveNote', 'setGuideFromServer', 'saveScript', 'deleteScript', 'tickGuideQuestion', 'resetGuideTicks', 'setGuideLearned', 'setGuideClientType',
  'saveSyncState', 'clearTombstone', 'markSynced', 'markRefused', 'markBillSynced',
  'putFromServer', 'removeFromServer', 'saveBillFromServer', 'wipeEverything',
];

const MAX_SCRIPT = 3000;
const nowIso = () => new Date().toISOString();
const isProgressId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 60;

// What is kept of the rep's place in the guide: ids and booleans only. Anything else in the slot is dropped when it is read.
function cleanProgress(raw) {
  const out = { learned: {}, ticks: {}, client_type: CLIENT_TYPE_IDS.includes(raw?.client_type) ? raw.client_type : null };
  for (const [id, yes] of Object.entries(raw?.learned ?? {})) if (isProgressId(id) && yes === true) out.learned[id] = true;
  for (const [id, list] of Object.entries(raw?.ticks ?? {})) {
    const clean = Array.isArray(list) ? [...new Set(list.filter((n) => Number.isInteger(n) && n >= 0 && n <= 99))] : [];
    if (isProgressId(id) && clean.length) out.ticks[id] = clean.sort((a, b) => a - b);
  }
  return out;
}
const NOT_YOURS = 'Only the rep who added this can change it. You can read it, and add your own people to it.';

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
  #contacts = new Map();
  #meetings = new Map();
  #enquiries = new Map();
  #reports = new Map();
  #calls = new Map();
  #notes = new Map();
  #scripts = new Map();
  #progress = { learned: {}, ticks: {}, client_type: null };
  #guide = { version: null, products: [] };
  #profile = null;
  #prefs = {};
  #positions = { names: [], pending: [] };
  #phoneIndex = null; // number -> { client, contact }, rebuilt when clients or people change

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

    for (const kind of KINDS) {
      for (const slot of await persist.keys(PREFIX[kind])) {
        const record = await store.#read(slot);
        if (record?.id) store.#map(kind).set(record.id, { ...DEFAULTS[kind], ...record });
      }
    }
    store.#profile = await store.#read(PROFILE_KEY);
    store.#sync = await store.#read(SYNC_KEY);
    store.#prefs = (await store.#read(PREFS_KEY)) ?? {};

    const progress = await store.#read(PROGRESS_KEY);
    if (progress) store.#progress = cleanProgress(progress);

    const guide = await store.#read(GUIDE_KEY);
    if (guide && Array.isArray(guide.products)) store.#guide = { version: typeof guide.version === 'string' ? guide.version : null, products: guide.products.filter((p) => p?.id).map(withGuideDefaults) };

    const positions = await store.#read(POSITIONS_KEY);
    if (positions && Array.isArray(positions.names)) store.#positions = { names: positions.names.filter((n) => typeof n === 'string'), pending: (positions.pending ?? []).filter((n) => typeof n === 'string') };

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
    this.#contacts.clear();
    this.#meetings.clear();
    this.#enquiries.clear();
    this.#reports.clear();
    this.#calls.clear();
    this.#notes.clear();
    this.#scripts.clear();
    this.#progress = { learned: {}, ticks: {}, client_type: null };
    this.#guide = { version: null, products: [] };
    this.#profile = null;
    this.#prefs = {};
    this.#positions = { names: [], pending: [] };
    this.#phoneIndex = null;
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
      rules.workArea(input.work_area),
      rules.billType(input.bill_type),
      rules.amountPaise(input.amount_paise),
      rules.optional(input.note, { max: rules.MAX_NOTE, label: 'Note' }),
      bill && !rules.imageKind(bill) ? 'Please use a JPG, PNG or WebP picture.' : null,
      bill && bill.length > rules.MAX_BILL_BYTES ? 'The picture is bigger than 5 MB.' : null,
    );

    // "Without bill" means there is no photo: one that was attached is dropped
    if (input.bill_type === 'without_bill') {
      bill = null;
      removeBill = true;
    }

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
      bill_type: input.bill_type,
      work_area: input.work_area,
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
      rules.businessName(input.name, { label: 'Name' }),
      rules.businessName(input.company, { label: 'Company', requiredField: false }),
      rules.phone(input.phone),
      rules.place(input.city, { label: 'Place' }),
      rules.optional(input.notes, { max: rules.MAX_NOTE, label: 'Notes' }),
    );

    const id = input.id ?? crypto.randomUUID();
    const old = this.#clients.get(id);
    const me = this.#profile;
    if (old && !this.canEdit(old)) throw new ValidationError(NOT_YOURS);

    // one number, one place in the pool (the same rule as for a person)
    const phone = normalizePhone(input.phone);
    const taken = phone ? this.numberOwner(phone, { exceptClient: id }) : null;
    if (taken) throw new ValidationError(`This number is already saved under ${taken}.`);
    const record = {
      id,
      name: input.name.trim(),
      company: String(input.company ?? '').trim(),
      phone: normalizePhone(input.phone) ?? '',
      city: String(input.city ?? '').trim(),
      notes: String(input.notes ?? '').trim(),
      // who added it and who works it are the office's: kept as they were, and for a new client "me" (the office does the same)
      assigned_to_code: old ? old.assigned_to_code : (me?.employee_code ?? null),
      assigned_to_name: old ? old.assigned_to_name : (me?.name ?? null),
      created_by_code: old ? old.created_by_code : (me?.employee_code ?? null),
      created_by_name: old ? old.created_by_name : (me?.name ?? null),
      synced: false,
      sync_error: null,
      created_at: old?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };

    await this.#write(PREFIX.client + id, record);
    this.#clients.set(id, record);
    this.#phoneIndex = null;
    this.#changed();
    return record;
  }

  // Meetings and calls keep the client's name (a copy), so deleting a client loses nothing. The people at it go with it.
  async deleteClient(id) {
    for (const person of this.contactsOf(id)) await this.#removeContact(person.id);

    await this.#persist.del(PREFIX.client + id);
    this.#clients.delete(id);
    this.#phoneIndex = null;
    await this.#remember('client', id);
    this.#changed();
  }

  // May this phone's rep change or delete the client or person? Only the one who added it (the office checks again); records from
  // before the office link (created_by_code null) are the rep's own, records the office added have ''. Everybody else reads only.
  canEdit(record) {
    const code = record?.created_by_code;
    return code === null || code === undefined || code === this.#profile?.employee_code; // '' = added by the office: not the rep's
  }

  canDelete(record) {
    return this.canEdit(record);
  }

  // Who added it, for the screen: "You", the rep's name, or "the office".
  addedBy(record) {
    if (this.canEdit(record)) return 'You';
    return record?.created_by_name || record?.created_by_code || 'the office';
  }

  // ---- people at a client (the shared pool, like the clients) ---------------------------

  get contacts() {
    return [...this.#contacts.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  contactsOf(clientId) {
    return this.contacts.filter((c) => c.client_id === clientId);
  }

  contactById(id) {
    return (id && this.#contacts.get(id)) || null;
  }

  // People who do not work at a company (a customer who buys on their own).
  get loosePeople() {
    return this.contacts.filter((c) => !c.client_id);
  }

  // input: { id?, client_id (null = no company), name, position, phone, email, notes }
  async saveContact(input) {
    check(
      !input.client_id || this.#clients.has(input.client_id) ? null : 'Pick the company this person works at.',
      rules.personName(input.name, { max: 150 }),
      String(input.position ?? '').trim() ? rules.position(input.position) : null,
      rules.phone(input.phone),
      rules.email(input.email),
      rules.optional(input.notes, { max: rules.MAX_NOTE, label: 'Notes' }),
    );

    const id = input.id ?? crypto.randomUUID();
    const old = this.#contacts.get(id);
    if (old && !this.canEdit(old)) throw new ValidationError(NOT_YOURS);
    const phone = normalizePhone(input.phone) ?? '';

    // one number, one person: a number that is already saved in the pool (under somebody else) is refused
    const taken = phone ? this.numberOwner(phone, { exceptContact: id }) : null;
    if (taken) throw new ValidationError(`This number is already saved under ${taken}.`);

    const position = cleanPosition(input.position);
    const record = {
      id,
      client_id: input.client_id || null,
      name: input.name.trim(),
      position,
      phone,
      email: String(input.email ?? '').trim(),
      notes: String(input.notes ?? '').trim(),
      created_by_code: old ? old.created_by_code : (this.#profile?.employee_code ?? null),
      created_by_name: old ? old.created_by_name : (this.#profile?.name ?? null),
      synced: false,
      sync_error: null,
      created_at: old?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };

    await this.#write(PREFIX.contact + id, record);
    this.#contacts.set(id, record);
    this.#phoneIndex = null;
    if (position) await this.#learnPosition(position);
    this.#changed();
    return record;
  }

  async deleteContact(id) {
    await this.#removeContact(id);
    this.#changed();
  }

  async #removeContact(id) {
    await this.#persist.del(PREFIX.contact + id);
    this.#contacts.delete(id);
    this.#phoneIndex = null;
    await this.#remember('contact', id);
  }

  // Who has this number already? "Rohit Sharma (JK Cement)" / "JK Cement", or null. Used before a number is saved.
  numberOwner(normalized, { exceptContact = null, exceptClient = null } = {}) {
    for (const person of this.#contacts.values()) {
      if (person.id !== exceptContact && person.phone === normalized) {
        const company = this.#clients.get(person.client_id)?.name;
        return company ? `${person.name} (${company})` : person.name;
      }
    }
    for (const client of this.#clients.values()) {
      if (client.id !== exceptClient && client.phone === normalized) return client.name;
    }
    return null;
  }

  // Who is behind this number? -> { client, contact } or null. A call is matched with this (client = the pool's company, contact = the person;
  // a person without a company has client null).
  matchNumber(normalized) {
    if (!this.#phoneIndex) {
      const index = new Map();
      for (const client of this.#clients.values()) if (client.phone) index.set(client.phone, { client, contact: null });
      for (const person of this.#contacts.values()) {
        const client = person.client_id ? this.#clients.get(person.client_id) : null;
        if (person.phone && (client || !person.client_id)) index.set(person.phone, { client, contact: person }); // a person's own number beats the company's switchboard
      }
      this.#phoneIndex = index;
    }
    return this.#phoneIndex.get(normalized) ?? null;
  }

  // ---- positions (a shared dropdown list) ----------------------------------------------

  // The names for the dropdown: what the office sent, what this phone added and has not sent yet, and the built-in ones.
  get positions() {
    const seen = new Map();
    for (const name of [...PRESET_POSITIONS, ...this.#positions.names, ...this.#positions.pending]) {
      const key = positionKey(name);
      if (key && !seen.has(key)) seen.set(key, cleanPosition(name));
    }
    return [...seen.values()];
  }

  get pendingPositions() {
    return [...this.#positions.pending];
  }

  async addPosition(name) {
    check(rules.position(name));
    const clean = cleanPosition(name);
    await this.#learnPosition(clean);
    this.#changed();
    return clean;
  }

  // a new position goes to the office with the next sync
  async #learnPosition(name) {
    const key = positionKey(name);
    if ([...PRESET_POSITIONS, ...this.#positions.names, ...this.#positions.pending].some((n) => positionKey(n) === key)) return;

    this.#positions = { ...this.#positions, pending: [...this.#positions.pending, name] };
    await this.#write(POSITIONS_KEY, this.#positions);
  }

  async setPositionsFromServer(names) {
    const clean = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && !rules.position(n)).map(cleanPosition))];
    const known = new Set(clean.map(positionKey));

    this.#positions = { names: clean, pending: this.#positions.pending.filter((n) => !known.has(positionKey(n))) };
    await this.#write(POSITIONS_KEY, this.#positions);
    this.#changed(false);
  }

  async clearPendingPositions(sent) {
    const gone = new Set(sent.map(positionKey));
    this.#positions = { names: [...this.#positions.names, ...this.#positions.pending.filter((n) => gone.has(positionKey(n)))], pending: this.#positions.pending.filter((n) => !gone.has(positionKey(n))) };
    await this.#write(POSITIONS_KEY, this.#positions);
  }

  // ---- enquiries: what a client asked for, where it stands, when to follow up ----------------------

  get enquiries() {
    return [...this.#enquiries.values()];
  }

  enquiryById(id) {
    return (id && this.#enquiries.get(id)) || null;
  }

  // The open enquiries that need the rep's action now (overdue, due today, or untouched), the most urgent first.
  actionableEnquiries(now = new Date()) {
    return this.enquiries.filter((e) => enquiryRules.needsAction(e, now)).sort((a, b) => enquiryRules.byUrgency(a, b, now));
  }

  /**
   * input: { id?, client_id, client_name, contact_id, contact_name, status, items: [{ product, brands, quantity, budget_paise }],
   *          next_followup_at (ISO|null), note }
   * A note, or a change of status, is added to the enquiry's timeline with the time. Closing (won / lost) clears the follow-up.
   */
  async saveEnquiry(input) {
    const items = (Array.isArray(input.items) ? input.items : []).map((i) => ({
      product: String(i?.product ?? '').trim(),
      brands: String(i?.brands ?? '').trim(),
      quantity: i?.quantity === undefined || i?.quantity === '' || i?.quantity === null ? 1 : Number(i.quantity),
      budget_paise: i?.budget_paise === undefined || i?.budget_paise === null || i?.budget_paise === '' ? null : Number(i.budget_paise),
    }));
    const note = String(input.note ?? '').trim();
    const followup = input.next_followup_at ? Date.parse(input.next_followup_at) : null;

    check(
      rules.required(input.client_name, { min: 2, max: 150, label: 'Client name' }),
      rules.optional(input.contact_name, { max: 150, label: 'Person' }),
      enquiryRules.isStatus(input.status) ? null : 'Pick a status.',
      items.length < 1 ? 'Add at least one product.' : items.length > enquiryRules.MAX_ITEMS ? `At most ${enquiryRules.MAX_ITEMS} products in one enquiry.` : null,
      ...items.flatMap((i, n) => [
        rules.required(i.product, { min: 2, max: 150, label: `Product ${n + 1}` }),
        rules.optional(i.brands, { max: 150, label: `Brands of product ${n + 1}` }),
        Number.isInteger(i.quantity) && i.quantity >= 1 && i.quantity <= 100_000 ? null : `Quantity of product ${n + 1} must be a whole number from 1 to 100000.`,
        i.budget_paise === null || (Number.isInteger(i.budget_paise) && i.budget_paise >= 0 && i.budget_paise <= enquiryRules.MAX_BUDGET_PAISE) ? null : `The budget of product ${n + 1} is not valid.`,
      ]),
      rules.optional(note, { max: rules.MAX_TEXT * 2.5, label: 'Note' }),
      followup !== null && Number.isNaN(followup) ? 'Pick a valid follow-up time.' : null,
      followup !== null && followup > Date.now() + TWO_YEARS ? 'A follow-up can be at most 2 years ahead.' : null,
    );

    const id = input.id ?? crypto.randomUUID();
    const old = this.#enquiries.get(id);
    const now = nowIso();
    const closed = enquiryRules.CLOSED.includes(input.status);

    const timeline = [...(old?.timeline ?? [])];
    if (!old) timeline.push({ at: now, text: note || 'Enquiry opened', status: input.status });
    else if (input.status !== old.status) timeline.push({ at: now, text: note, status: input.status });
    else if (note) timeline.push({ at: now, text: note, status: null });

    const record = {
      id,
      client_id: input.client_id ?? null,
      client_name: input.client_name.trim(),
      contact_id: input.contact_id ?? null,
      contact_name: String(input.contact_name ?? '').trim(),
      status: input.status,
      items,
      opened_at: old?.opened_at ?? now,
      next_followup_at: closed || followup === null ? null : new Date(followup).toISOString(),
      closed_at: closed ? (old?.status === input.status && old.closed_at ? old.closed_at : now) : null,
      timeline: timeline.slice(-enquiryRules.MAX_TIMELINE),
      synced: false,
      sync_error: null,
      created_at: old?.created_at ?? now,
      updated_at: now,
    };

    await this.#write(PREFIX.enquiry + id, record);
    this.#enquiries.set(id, record);
    this.#changed();
    return record;
  }

  async deleteEnquiry(id) {
    await this.#persist.del(PREFIX.enquiry + id);
    this.#enquiries.delete(id);
    await this.#remember('enquiry', id);
    this.#changed();
  }

  // ---- daily reports: one per day, written by the rep ----------------------------------------------

  // Newest day first.
  get reports() {
    return [...this.#reports.values()].sort((a, b) => b.report_date.localeCompare(a.report_date));
  }

  reportFor(day) {
    return [...this.#reports.values()].find((r) => r.report_date === day) ?? null;
  }

  /**
   * input: { id (the same id every time for one day: see core/ids.js), report_date 'YYYY-MM-DD', notes, tomorrow_plan, issues,
   *          figures {calls, calls_missed, talk_seconds, meetings, enquiries_new, enquiries_worked, expenses_paise}, submit }
   */
  async saveReport(input) {
    const day = String(input.report_date ?? '');
    const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00`) : NaN;
    const figures = {};
    for (const key of ['calls', 'calls_missed', 'talk_seconds', 'meetings', 'enquiries_new', 'enquiries_worked', 'expenses_paise']) {
      const n = Number(input.figures?.[key] ?? 0);
      figures[key] = Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 1_000_000_000_000) : 0;
    }

    check(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id ?? '') ? null : 'The report has no valid id.',
      Number.isNaN(at) ? 'Pick the day of the report.' : null,
      at > Date.now() + 86_400_000 ? 'A report cannot be for a day that has not come.' : null,
      at < Date.now() - 31 * 86_400_000 ? 'A report can only be for the last 31 days.' : null,
      rules.optional(input.notes, { max: rules.MAX_LONG_TEXT, label: 'What happened' }),
      rules.optional(input.tomorrow_plan, { max: rules.MAX_NOTE, label: 'Plan for tomorrow' }),
      rules.optional(input.issues, { max: rules.MAX_NOTE, label: 'Needs help with' }),
    );

    const id = this.reportFor(day)?.id ?? input.id; // one report per day, whatever id was asked for
    const old = this.#reports.get(id);
    const now = nowIso();

    const record = {
      id,
      report_date: day,
      notes: String(input.notes ?? '').trim(),
      tomorrow_plan: String(input.tomorrow_plan ?? '').trim(),
      issues: String(input.issues ?? '').trim(),
      figures,
      submitted_at: input.submit ? (old?.submitted_at ?? now) : (old?.submitted_at ?? null),
      synced: false,
      sync_error: null,
      created_at: old?.created_at ?? now,
      updated_at: now,
    };

    await this.#write(PREFIX.report + id, record);
    this.#reports.set(id, record);
    this.#changed();
    return record;
  }

  // ---- calls (matched to a number of the pool; the phone's other calls are never stored) -----------

  // Newest first.
  get calls() {
    return [...this.#calls.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  callsOf(clientId) {
    return this.calls.filter((c) => c.client_id === clientId);
  }

  hasCall(id) {
    return this.#calls.has(id);
  }

  // Saves calls the matcher found (src/calls/matcher.js). A call that is already known is skipped: importing twice is harmless.
  // Returns how many were new.
  async saveCalls(list) {
    let added = 0;

    for (const input of list) {
      check(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id ?? '') ? null : 'The call has no valid id.',
        ['incoming', 'outgoing', 'missed'].includes(input.direction) ? null : 'The call has no direction.',
        /^\+[0-9]{8,15}$/.test(input.number ?? '') ? null : 'The call has no valid number.',
        Number.isNaN(Date.parse(input.started_at)) ? 'The call has no time.' : null,
        Number.isInteger(input.duration_seconds) && input.duration_seconds >= 0 && input.duration_seconds <= 86_400 ? null : 'The call length is not valid.',
      );
      if (this.#calls.has(input.id)) continue;

      const record = {
        id: input.id,
        direction: input.direction,
        number: input.number,
        client_id: input.client_id ?? null,
        contact_id: input.contact_id ?? null,
        client_name: String(input.client_name ?? '').slice(0, 150),
        contact_name: String(input.contact_name ?? '').slice(0, 150),
        started_at: new Date(input.started_at).toISOString(),
        duration_seconds: input.duration_seconds,
        synced: false,
        sync_error: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      await this.#write(PREFIX.call + record.id, record);
      this.#calls.set(record.id, record);
      added++;
    }

    if (added) this.#changed();
    return added;
  }

  // ---- settings of this phone (not shared) -----------------------------------------------

  get prefs() {
    return { ...this.#prefs };
  }

  async savePrefs(patch) {
    this.#prefs = { ...this.#prefs, ...patch };
    await this.#write(PREFS_KEY, this.#prefs);
    this.#changed(false);
  }

  // Switching to another rep: everything this phone holds is erased (the PIN stays). Only meant to be used once the office has the
  // records (or the person said they may go); the app checks that first.
  async wipeEverything() {
    for (const prefix of Object.values(PREFIX)) {
      for (const slot of await this.#persist.keys(prefix)) await this.#persist.del(slot);
    }
    for (const slot of [PROFILE_KEY, SYNC_KEY, PREFS_KEY, POSITIONS_KEY, GUIDE_KEY, PROGRESS_KEY]) await this.#persist.del(slot);

    this.#guide = { version: null, products: [] };
    this.#progress = { learned: {}, ticks: {}, client_type: null };
    for (const kind of KINDS) this.#map(kind).clear();
    this.#tombs.clear();
    this.#profile = null;
    this.#sync = null;
    this.#prefs = {};
    this.#positions = { names: [], pending: [] };
    this.#phoneIndex = null;
    this.#changed(false);
  }

  // ---- product guide: the manager writes it, every rep reads it (offline) ---------------------------------

  get guideProducts() {
    return this.#guide.products;
  }

  get guideVersion() {
    return this.#guide.version;
  }

  productById(id) {
    return (id && this.#guide.products.find((p) => p.id === id)) || null;
  }

  // The list the office sent (already cleaned by src/sync/merge.js). It replaces the old one as a whole: a product the manager removed is gone.
  async setGuideFromServer({ version, products }) {
    this.#guide = { version: typeof version === 'string' ? version : null, products: Array.isArray(products) ? products.map(withGuideDefaults) : [] };
    await this.#write(GUIDE_KEY, this.#guide);
    this.#changed(false);
  }

  // A rep asks the manager to add or correct something in the guide. Newest first.
  get notes() {
    return [...this.#notes.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // input: { product_id (a product of the guide, or null), product_name, body }
  async saveNote(input) {
    const product = input.product_id ? this.productById(input.product_id) : null;
    const name = product ? product.name : String(input.product_name ?? '').trim();

    check(
      input.product_id && !product ? 'This product is not in the guide any more.' : null,
      product ? null : rules.businessName(name, { label: 'Product' }),
      rules.required(input.body, { min: 3, max: 500, label: 'Your request' }),
    );

    const id = crypto.randomUUID();
    const now = nowIso();
    const record = { id, product_id: product?.id ?? null, product_name: name.slice(0, 200), body: String(input.body).trim(), synced: false, sync_error: null, created_at: now, updated_at: now };

    await this.#write(PREFIX.note + id, record);
    this.#notes.set(id, record);

    // a short history: the oldest requests that were already sent are forgotten
    const sent = this.notes.filter((n) => n.synced);
    for (const old of sent.slice(MAX_NOTES_KEPT)) {
      await this.#persist.del(PREFIX.note + old.id);
      this.#notes.delete(old.id);
    }

    this.#changed();
    return record;
  }

  // ---- my scripts: the rep's own pitch for a product ----------------------------------------------

  // Newest first.
  get scripts() {
    return [...this.#scripts.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  scriptById(id) {
    return (id && this.#scripts.get(id)) || null;
  }

  scriptsOf(productId) {
    return this.scripts.filter((s) => productId && s.product_id === productId);
  }

  // input: { id?, product_id (a product of the guide, or null), product_name (when it is not in the guide), title, body }
  async saveScript(input) {
    const product = input.product_id ? this.productById(input.product_id) : null;
    const name = product ? product.name : String(input.product_name ?? '').trim();

    check(
      input.product_id && !product ? 'This product is not in the guide any more.' : null,
      product ? null : rules.businessName(name, { label: 'Product' }),
      rules.optional(input.title, { max: 120, label: 'Title' }),
      rules.required(input.body, { min: 3, max: MAX_SCRIPT, label: 'Your script' }),
    );

    const id = input.id ?? crypto.randomUUID();
    const old = this.#scripts.get(id);
    const now = nowIso();
    const record = {
      id,
      product_id: product?.id ?? null,
      product_name: name.slice(0, 200),
      title: String(input.title ?? '').trim(),
      body: String(input.body).trim(),
      synced: false,
      sync_error: null,
      created_at: old?.created_at ?? now,
      updated_at: now,
    };

    await this.#write(PREFIX.script + id, record);
    this.#scripts.set(id, record);
    this.#changed();
    return record;
  }

  async deleteScript(id) {
    await this.#persist.del(PREFIX.script + id);
    this.#scripts.delete(id);
    await this.#remember('script', id);
    this.#changed();
  }

  // ---- the rep's place in the guide (only ids and yes / no, never names or free text; stays on this phone) ----------------

  get guideProgress() {
    return { learned: { ...this.#progress.learned }, ticks: Object.fromEntries(Object.entries(this.#progress.ticks).map(([k, v]) => [k, [...v]])), client_type: this.#progress.client_type };
  }

  async #saveProgress() {
    await this.#write(PROGRESS_KEY, this.#progress);
    this.#changed(false);
  }

  // Tick or untick one question of a product's checklist (by its number in the list).
  async tickGuideQuestion(productId, index) {
    if (!isProgressId(productId) || !Number.isInteger(index) || index < 0 || index > 99) return;

    const now = new Set(this.#progress.ticks[productId] ?? []);
    if (now.has(index)) now.delete(index);
    else now.add(index);

    if (now.size) this.#progress.ticks[productId] = [...now].sort((a, b) => a - b);
    else delete this.#progress.ticks[productId];
    await this.#saveProgress();
  }

  async resetGuideTicks(productId) {
    if (!isProgressId(productId) || !this.#progress.ticks[productId]) return;
    delete this.#progress.ticks[productId];
    await this.#saveProgress();
  }

  async setGuideLearned(productId, learned) {
    if (!isProgressId(productId)) return;
    if (learned) this.#progress.learned[productId] = true;
    else delete this.#progress.learned[productId];
    await this.#saveProgress();
  }

  async setGuideClientType(type) {
    this.#progress.client_type = CLIENT_TYPE_IDS.includes(type) ? type : null;
    await this.#saveProgress();
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
      followup !== null && followup > Date.now() + TWO_YEARS ? 'A follow-up can be at most 2 years ahead.' : null,
    );

    const id = input.id ?? crypto.randomUUID();
    const old = this.#meetings.get(id);
    const record = {
      id,
      client_id: input.client_id ?? null,
      client_name: input.client_name.trim(),
      // the people met: only ids (the people themselves are in the pool), at most 20, no repeats
      contact_ids: [...new Set((input.contact_ids ?? []).filter((c) => typeof c === 'string'))].slice(0, MAX_PEOPLE_PER_MEETING),
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
    return { expense: this.#expenses, client: this.#clients, contact: this.#contacts, meeting: this.#meetings, enquiry: this.#enquiries, call: this.#calls, report: this.#reports, note: this.#notes, script: this.#scripts }[kind];
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
    if (kind === 'client' || kind === 'contact') this.#phoneIndex = null;
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
    return KINDS.reduce((sum, kind) => sum + this.dirty(kind).length, 0) + this.#tombs.size + this.#positions.pending.length;
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
      contacts: this.contacts.map(strip),
      meetings: this.meetings.map(strip),
      enquiries: this.enquiries.map(strip),
      calls: this.calls.map(strip),
      reports: this.reports.map(strip),
      product_requests: this.notes.map(strip),
      scripts: this.scripts.map(strip),
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
    if (kind === 'client' || kind === 'contact') this.#phoneIndex = null;
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
