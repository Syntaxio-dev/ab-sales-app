// A stand-in for the website's Sales API, with the same rules as the real one (see docs/sales-api.md in the website project):
// private records (expenses, meetings, calls) belong to one rep, the client pool (clients + the people at them) and the position
// list are shared, locked reviews, soft deletes, "newest change wins", cursors, bill photos. It is only used by tests.

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const error = (status, code, message, errors = {}) => json(status, { code, message, errors });

const KINDS = ['expenses', 'clients', 'contacts', 'meetings', 'enquiries', 'calls', 'reports', 'product_requests', 'scripts'];
const NOT_PULLED = new Set(['product_requests']); // a rep's request for a guide note only goes to the office
const STATUSES = ['new', 'price_to_send', 'price_sent', 'callback', 'meeting_planned', 'negotiation', 'won', 'lost'];
const SHARED = new Set(['clients', 'contacts']);
const DELETABLE = ['expenses', 'clients', 'contacts', 'meetings', 'enquiries', 'scripts'];
const PRESETS = ['Owner / Director', 'Purchase Manager', 'Procurement Head', 'Lab Head', 'Quality (QC) Head', 'Production Head', 'Store Manager', 'Accounts', 'Other'];

export class FakeOffice {
  constructor() {
    this.users = new Map();      // login (upper case) -> { password, name, code, active, userId }
    this.tokens = new Map();     // token -> userId
    this.rows = Object.fromEntries(KINDS.map((k) => [k, new Map()]));   // uuid -> { owner, data, rev, deleted, assignedTo? }
    this.positions = [...PRESETS];
    this.products = [];          // the product guide the manager wrote (raw, as the API sends it)
    this.productsVersion = 'v0000000000000001';
    this.bills = new Map();      // expense uuid -> base64
    this.rev = 0;
    this.offline = false;
    this.calls = [];
    this.onPush = null;          // (body) => void, runs while a push is "on its way"
    this.failPushWith = null;    // e.g. 500
    this.limit = 1000;
  }

  addRep(code, password = 'secret-pass-1', name = `Rep ${code}`) {
    const userId = this.users.size + 1;
    this.users.set(code.toUpperCase(), { password, name, code: code.toUpperCase(), active: true, userId });
    return userId;
  }

  userById(id) {
    return [...this.users.values()].find((x) => x.userId === id) ?? null;
  }

  // what the website's manager does in the admin panel
  review(uuid, status, reason = null) {
    const row = this.rows.expenses.get(uuid);
    row.data = { ...row.data, status, reject_reason: reason, reviewed_at: new Date().toISOString() };
    row.rev = ++this.rev;
  }

  // the manager edits the product guide in the admin: any change is a new version stamp
  setProducts(products) {
    this.products = products;
    this.productsVersion = `v${String(++this.rev).padStart(15, '0')}`;
  }

  // the manager gives a client to a rep (an admin edit is a newer version for the phones)
  assign(uuid, code) {
    const row = this.rows.clients.get(uuid);
    row.assignedTo = this.users.get(code.toUpperCase()).userId;
    row.data = { ...row.data, updated_at: new Date(Date.now() + 1000).toISOString() };
    row.rev = ++this.rev;
  }

  switchOff(code) {
    this.users.get(code.toUpperCase()).active = false;
    for (const [token, id] of this.tokens) if (id === this.users.get(code.toUpperCase()).userId) this.tokens.delete(token);
  }

  count(kind, owner = null) {
    return [...this.rows[kind].values()].filter((r) => !r.deleted && (owner === null || r.owner === owner)).length;
  }

  fetch = async (url, init = {}) => {
    if (this.offline) throw new TypeError('network down');

    const u = new URL(url);
    const path = u.pathname.replace('/api/sales/v1', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    const auth = /^Bearer (.+)$/.exec(init.headers?.Authorization ?? '')?.[1];
    this.calls.push({ method, path, body, query: Object.fromEntries(u.searchParams), headers: init.headers, init });

    if (path === '/auth/login' && method === 'POST') return this.login(body);

    const userId = this.tokens.get(auth);
    if (!userId) return error(401, 'UNAUTHENTICATED', 'Please sign in again.');
    const user = this.userById(userId);
    if (!user.active) return error(403, 'ACCOUNT_INACTIVE', 'Your account is switched off.');

    if (path === '/auth/logout') { this.tokens.delete(auth); return json(200, { message: 'Signed out.' }); }
    if (path === '/sync/push' && method === 'POST') return this.push(userId, body);
    if (path === '/sync/pull') return this.pull(userId, u.searchParams.get('since'));
    if (path === '/uploads/bill' && method === 'POST') return this.upload(userId, body);
    if (path === '/products' && method === 'GET') {
      return u.searchParams.get('version') === this.productsVersion
        ? json(200, { version: this.productsVersion, unchanged: true })
        : json(200, { version: this.productsVersion, unchanged: false, products: this.products });
    }

    const bill = /^\/expenses\/([^/]+)\/bill$/.exec(path);
    if (bill) {
      const row = this.rows.expenses.get(bill[1]);
      return row && row.owner === userId && this.bills.has(bill[1]) ? json(200, { mime: 'image/jpeg', data_base64: this.bills.get(bill[1]) }) : error(404, 'NOT_FOUND', 'No bill photo.');
    }

    return error(404, 'NOT_FOUND', 'Not found.');
  };

  login({ login, password }) {
    const user = this.users.get(String(login).toUpperCase());
    if (!user || user.password !== password) return error(401, 'INVALID_CREDENTIALS', 'Employee code / phone or password is wrong.');
    if (!user.active) return error(403, 'ACCOUNT_INACTIVE', 'Your account is switched off.');

    for (const [token, id] of this.tokens) if (id === user.userId) this.tokens.delete(token);
    const token = `token-${user.userId}-${Math.random().toString(36).slice(2)}`;
    this.tokens.set(token, user.userId);

    return json(200, { token, token_type: 'Bearer', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), account: { name: user.name, employee_code: user.code, phone: null } });
  }

  // the numbers saved in the pool (clients and people), the same spelling the phones send
  poolNumbers(exceptUuid = null) {
    const numbers = new Map();
    for (const kind of ['clients', 'contacts']) {
      for (const row of this.rows[kind].values()) {
        if (row.data.uuid !== exceptUuid && row.data.phone) numbers.set(row.data.phone, row.data.name);
      }
    }
    return numbers;
  }

  validate(kind, r) {
    if (typeof r?.uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.uuid)) return 'The id is not valid.';
    if (Date.parse(r.updated_at) > Date.now() + 10 * 60_000) return "This phone's clock is ahead of the office's. Set the right date and time on the phone.";
    if (['clients', 'contacts'].includes(kind) && r.phone) {
      const owner = this.poolNumbers(r.uuid).get(r.phone);
      if (owner) return `This number is already saved under ${owner}.`;
    }
    if (['meetings', 'enquiries'].includes(kind) && r.next_followup_at && Date.parse(r.next_followup_at) > Date.now() + 2 * 365 * 86_400_000) return 'The follow-up is too far ahead.';
    if (kind === 'calls' && !this.poolNumbers().has(r.number)) return 'This number is not a saved client number.';
    if (kind === 'expenses') {
      if (!['travel', 'food', 'lodging', 'fuel', 'other'].includes(r.category)) return 'Pick a category.';
      if (!Number.isInteger(r.amount_paise) || r.amount_paise < 1 || r.amount_paise > 100_000_000) return 'The amount is not valid.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.expense_date ?? '')) return 'The date is not valid.';
    }
    if (kind === 'clients' && String(r.name ?? '').trim().length < 2) return 'The name is too short.';
    if (kind === 'contacts') {
      if (String(r.name ?? '').trim().length < 2) return 'The name is too short.';
      if (r.client_uuid != null && (typeof r.client_uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.client_uuid))) return 'The client id is not valid.'; // null = no company
    }
    if (kind === 'scripts' && (String(r.body ?? '').trim().length < 3 || String(r.product_name ?? '').trim().length < 2)) return 'The script is too short.';
    if (kind === 'meetings' && !String(r.client_name ?? '').trim()) return 'The client name is required.';
    if (kind === 'meetings' && r.contact_uuids !== undefined && (!Array.isArray(r.contact_uuids) || r.contact_uuids.length > 20)) return 'The people are not valid.';
    if (kind === 'enquiries') {
      if (String(r.client_name ?? '').trim().length < 2) return 'The client name is too short.';
      if (!STATUSES.includes(r.status)) return 'The status is not valid.';
      if (!Array.isArray(r.items) || r.items.length < 1 || r.items.length > 10) return 'An enquiry needs 1 to 10 products.';
      if (r.items.some((i) => String(i?.product ?? '').trim().length < 2 || !Number.isInteger(i?.quantity) || i.quantity < 1)) return 'A product is not valid.';
      if (!Array.isArray(r.timeline ?? []) || (r.timeline ?? []).length > 100) return 'The notes are not valid.';
    }
    if (kind === 'reports') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.report_date ?? '')) return 'The day is not valid.';
      if (String(r.notes ?? '').length > 2000) return 'The notes are too long.';
    }
    if (kind === 'calls') {
      if (!['incoming', 'outgoing', 'missed'].includes(r.direction)) return 'The direction is not valid.';
      if (!/^\+[0-9]{8,15}$/.test(r.number ?? '')) return 'The number is not valid.';
      if (!Number.isInteger(r.duration_seconds) || r.duration_seconds < 0 || r.duration_seconds > 86_400) return 'The duration is not valid.';
    }
    return null;
  }

  addPosition(name) {
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (clean.length < 2 || clean.length > 60 || !/^[\p{L}\p{N} &/().,'-]+$/u.test(clean)) return { name: clean, status: 'rejected', code: 'INVALID', message: 'A position is 2 to 60 letters or digits.' };
    if (this.positions.some((p) => p.toLowerCase() === clean.toLowerCase())) return { name: clean, status: 'duplicate' };
    this.positions.push(clean);
    return { name: clean, status: 'accepted' };
  }

  push(userId, body) {
    if (this.failPushWith) return error(this.failPushWith, 'SERVER_ERROR', 'Server error.');
    this.onPush?.(body);

    const results = { ...Object.fromEntries(KINDS.map((k) => [k, []])), positions: [], deleted: Object.fromEntries(DELETABLE.map((k) => [k, []])) };

    for (const kind of KINDS) {
      for (const [index, r] of (body[kind] ?? []).entries()) {
        const bad = this.validate(kind, r);
        if (bad) { results[kind].push({ uuid: r?.uuid ?? null, index, status: 'rejected', code: 'INVALID', message: bad }); continue; }

        const row = this.rows[kind].get(r.uuid);
        const shared = SHARED.has(kind);
        if (row && !shared && row.owner !== userId) { results[kind].push({ uuid: r.uuid, index, status: 'rejected', code: 'UUID_TAKEN', message: 'This id cannot be used.' }); continue; }
        if (row?.deleted) { results[kind].push({ uuid: r.uuid, index, status: 'duplicate' }); continue; }
        // the pool is shared to read; only the rep who added a client or a person changes it
        if (row && shared && row.owner !== userId) { results[kind].push({ uuid: r.uuid, index, status: 'rejected', code: 'NOT_ALLOWED', message: 'Only the person who added it can change this.' }); continue; }
        if (row && (kind === 'calls' || kind === 'product_requests')) { results[kind].push({ uuid: r.uuid, index, status: 'duplicate' }); continue; }
        if (kind === 'product_requests' && !(String(r.body ?? '').trim().length >= 3 && String(r.product_name ?? '').trim().length >= 2)) {
          results[kind].push({ uuid: r.uuid, index, status: 'rejected', code: 'INVALID', message: 'The request is too short.' });
          continue;
        }
        if (!row && kind === 'reports' && [...this.rows.reports.values()].some((x) => x.owner === userId && x.data.report_date === r.report_date)) {
          results[kind].push({ uuid: r.uuid, index, status: 'rejected', code: 'INVALID', message: 'A report for this day was already sent.' });
          continue;
        }
        if (row && Date.parse(row.data.updated_at) >= Date.parse(r.updated_at)) { results[kind].push({ uuid: r.uuid, index, status: 'duplicate' }); continue; }
        if (row && kind === 'expenses' && row.data.status !== 'pending') { results[kind].push({ uuid: r.uuid, index, status: 'rejected', code: 'LOCKED', message: 'Already reviewed.' }); continue; }

        const old = row?.data ?? {};
        const data = { ...r, has_bill: r.has_bill === true && this.bills.has(r.uuid) };
        if (kind === 'expenses') Object.assign(data, { status: old.status ?? 'pending', reviewed_at: old.reviewed_at ?? null, reject_reason: old.reject_reason ?? null });
        this.rows[kind].set(r.uuid, { owner: row?.owner ?? userId, assignedTo: row?.assignedTo ?? userId, data, rev: ++this.rev, deleted: false });
        results[kind].push({ uuid: r.uuid, index, status: 'accepted' });

        if (kind === 'contacts' && r.position) this.addPosition(r.position);
      }
    }

    for (const name of body.positions ?? []) results.positions.push({ uuid: null, index: results.positions.length, ...this.addPosition(name) });

    for (const kind of DELETABLE) {
      for (const uuid of body.deleted?.[kind] ?? []) {
        const row = this.rows[kind].get(uuid);
        if (!row || row.deleted) { results.deleted[kind].push({ uuid, index: 0, status: 'accepted' }); continue; }
        if (row.owner !== userId) {
          results.deleted[kind].push(SHARED.has(kind) ? { uuid, index: 0, status: 'rejected', code: 'NOT_ALLOWED', message: 'Only the person who added it can delete this.' } : { uuid, index: 0, status: 'accepted' });
          continue;
        }
        if (kind === 'expenses' && row.data.status !== 'pending') { results.deleted[kind].push({ uuid, index: 0, status: 'rejected', code: 'LOCKED', message: 'Already reviewed.' }); continue; }
        row.deleted = true;
        row.rev = ++this.rev;
        if (kind === 'clients') {
          for (const person of this.rows.contacts.values()) if (person.data.client_uuid === uuid && !person.deleted) { person.deleted = true; person.rev = ++this.rev; }
        }
        results.deleted[kind].push({ uuid, index: 0, status: 'accepted' });
      }
    }

    return json(200, { results, server_time: new Date().toISOString() });
  }

  shape(kind, row) {
    const out = { ...row.data, deleted: row.deleted };
    if (kind === 'expenses') out.has_bill = this.bills.has(row.data.uuid);
    if (kind === 'clients' || kind === 'contacts') {
      const added = this.userById(row.owner);
      Object.assign(out, { created_by_code: added?.code ?? null, created_by_name: added?.name ?? null });
    }
    if (kind === 'clients') {
      const works = this.userById(row.assignedTo);
      Object.assign(out, { assigned_to_code: works?.code ?? null, assigned_to_name: works?.name ?? null });
    }
    return out;
  }

  pull(userId, since) {
    const out = { has_more: false };
    const from = since ? Number(since) : 0;
    let capped = null;

    for (const kind of KINDS.filter((k) => !NOT_PULLED.has(k))) {
      const rows = [...this.rows[kind].values()].filter((r) => (SHARED.has(kind) || r.owner === userId) && r.rev >= from).sort((a, b) => a.rev - b.rev);
      const page = rows.slice(0, this.limit);
      if (rows.length > this.limit) { capped = Math.min(capped ?? Infinity, page.at(-1).rev); out.has_more = true; }
      out[kind] = page.map((r) => this.shape(kind, r));
    }

    out.positions = [...this.positions];
    out.cursor = String(capped ?? this.rev);
    out.server_time = new Date().toISOString();
    return json(200, out);
  }

  upload(userId, { expense_uuid: uuid, data_base64: data }) {
    const row = this.rows.expenses.get(uuid);
    if (!row || row.owner !== userId) return error(404, 'NOT_FOUND', 'This expense is not on the server yet.');
    if (row.data.status !== 'pending') return error(409, 'LOCKED', 'Already reviewed.');
    if (!/^[A-Za-z0-9+/=]+$/.test(data ?? '')) return error(422, 'INVALID', 'Not a picture.');

    this.bills.set(uuid, data);
    row.rev = ++this.rev;
    return json(200, { status: 'stored' });
  }
}
