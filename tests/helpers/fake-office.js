// A stand-in for the website's Sales API, with the same rules as the real one (see docs/sales-api.md in the website project):
// owners, UUIDs, locked reviews, soft deletes, "newest change wins", cursors, bill photos. It is only used by tests.

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const error = (status, code, message, errors = {}) => json(status, { code, message, errors });

const KINDS = ['expenses', 'clients', 'meetings'];

export class FakeOffice {
  constructor() {
    this.users = new Map();      // login (upper case) -> { password, name, code, active, userId }
    this.tokens = new Map();     // token -> userId
    this.rows = { expenses: new Map(), clients: new Map(), meetings: new Map() };   // uuid -> { owner, data, rev, deleted }
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

  // what the website's manager does in the admin panel
  review(uuid, status, reason = null) {
    const row = this.rows.expenses.get(uuid);
    row.data = { ...row.data, status, reject_reason: reason, reviewed_at: new Date().toISOString() };
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
    const user = [...this.users.values()].find((x) => x.userId === userId);
    if (!user.active) return error(403, 'ACCOUNT_INACTIVE', 'Your account is switched off.');

    if (path === '/auth/logout') { this.tokens.delete(auth); return json(200, { message: 'Signed out.' }); }
    if (path === '/sync/push' && method === 'POST') return this.push(userId, body);
    if (path === '/sync/pull') return this.pull(userId, u.searchParams.get('since'));
    if (path === '/uploads/bill' && method === 'POST') return this.upload(userId, body);

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

  validate(kind, r) {
    if (typeof r?.uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.uuid)) return 'The id is not valid.';
    if (kind === 'expenses') {
      if (!['travel', 'food', 'lodging', 'fuel', 'other'].includes(r.category)) return 'Pick a category.';
      if (!Number.isInteger(r.amount_paise) || r.amount_paise < 1 || r.amount_paise > 100_000_000) return 'The amount is not valid.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.expense_date ?? '')) return 'The date is not valid.';
    }
    if (kind === 'clients' && String(r.name ?? '').trim().length < 2) return 'The name is too short.';
    if (kind === 'meetings' && !String(r.client_name ?? '').trim()) return 'The client name is required.';
    return null;
  }

  push(userId, body) {
    if (this.failPushWith) return error(this.failPushWith, 'SERVER_ERROR', 'Server error.');
    this.onPush?.(body);

    const results = { expenses: [], clients: [], meetings: [], deleted: { expenses: [], clients: [], meetings: [] } };

    for (const kind of KINDS) {
      for (const [index, r] of (body[kind] ?? []).entries()) {
        const bad = this.validate(kind, r);
        if (bad) { results[kind].push({ uuid: r?.uuid ?? null, index, status: 'rejected', code: 'INVALID', message: bad }); continue; }

        const row = this.rows[kind].get(r.uuid);
        if (row && row.owner !== userId) { results[kind].push({ uuid: r.uuid, index, status: 'rejected', code: 'UUID_TAKEN', message: 'This id cannot be used.' }); continue; }
        if (row?.deleted) { results[kind].push({ uuid: r.uuid, index, status: 'duplicate' }); continue; }
        if (row && Date.parse(row.data.updated_at) >= Date.parse(r.updated_at)) { results[kind].push({ uuid: r.uuid, index, status: 'duplicate' }); continue; }
        if (row && kind === 'expenses' && row.data.status !== 'pending') { results[kind].push({ uuid: r.uuid, index, status: 'rejected', code: 'LOCKED', message: 'Already reviewed.' }); continue; }

        const old = row?.data ?? {};
        const data = { ...r, has_bill: r.has_bill === true && this.bills.has(r.uuid) };
        if (kind === 'expenses') Object.assign(data, { status: old.status ?? 'pending', reviewed_at: old.reviewed_at ?? null, reject_reason: old.reject_reason ?? null });
        this.rows[kind].set(r.uuid, { owner: userId, data, rev: ++this.rev, deleted: false });
        results[kind].push({ uuid: r.uuid, index, status: 'accepted' });
      }

      for (const uuid of body.deleted?.[kind] ?? []) {
        const row = this.rows[kind].get(uuid);
        if (!row || row.owner !== userId || row.deleted) { results.deleted[kind].push({ uuid, index: 0, status: 'accepted' }); continue; }
        if (kind === 'expenses' && row.data.status !== 'pending') { results.deleted[kind].push({ uuid, index: 0, status: 'rejected', code: 'LOCKED', message: 'Already reviewed.' }); continue; }
        row.deleted = true;
        row.rev = ++this.rev;
        results.deleted[kind].push({ uuid, index: 0, status: 'accepted' });
      }
    }

    return json(200, { results, server_time: new Date().toISOString() });
  }

  pull(userId, since) {
    const out = { has_more: false };
    const from = since ? Number(since) : 0;
    let capped = null;

    for (const kind of KINDS) {
      const rows = [...this.rows[kind].values()].filter((r) => r.owner === userId && r.rev >= from).sort((a, b) => a.rev - b.rev);
      const page = rows.slice(0, this.limit);
      if (rows.length > this.limit) { capped = Math.min(capped ?? Infinity, page.at(-1).rev); out.has_more = true; }
      out[kind] = page.map((r) => ({ ...r.data, has_bill: kind === 'expenses' ? this.bills.has(r.data.uuid) : undefined, deleted: r.deleted }));
    }

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
