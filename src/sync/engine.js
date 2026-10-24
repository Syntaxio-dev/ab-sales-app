import { fromBase64, toBase64 } from '../security/crypto.js';
import { CLEANERS, decide, keepPendingBill } from './merge.js';
import { SyncError } from './http.js';

// Keeps the phone and the office in step. The rules that make it safe to run again and again, at any time, on any network:
//  - the phone is the source of the rep's records (it writes first, offline is fine); the office decides only the status
//    of an expense, and that decision always wins on the phone;
//  - every record carries its own UUID, so sending twice never makes two (the office answers "duplicate");
//  - a record is marked "sent" only after the office accepted exactly that version; edits made while a push was on its
//    way stay "not sent" and go in the next round;
//  - a delete is remembered until the office has heard of it;
//  - nothing the office sends is trusted blindly (see merge.js);
//  - one sync at a time; a change during a sync starts one more right after it.

const PUSH_ROUNDS = 10;
const PULL_PAGES = 30;
const BILLS_PER_RUN = 15;

export const KINDS = [
  { kind: 'expense', wire: 'expenses' },
  { kind: 'client', wire: 'clients' },
  { kind: 'meeting', wire: 'meetings' },
];

const wireOf = {
  expense: (r) => ({ uuid: r.id, category: r.category, amount_paise: r.amount_paise, expense_date: r.expense_date, note: r.note, has_bill: r.has_bill, updated_at: r.updated_at }),
  client: (r) => ({ uuid: r.id, name: r.name, company: r.company, phone: r.phone, city: r.city, notes: r.notes, updated_at: r.updated_at }),
  meeting: (r) => ({
    uuid: r.id, client_uuid: r.client_id, client_name: r.client_name, meeting_at: r.meeting_at, purpose: r.purpose,
    discussion: r.discussion, outcome: r.outcome, next_followup_at: r.next_followup_at, updated_at: r.updated_at,
  }),
};

export class SyncEngine {
  #store;
  #http;
  #listeners = new Set();
  #busy = false;
  #again = false;
  #timer = null;
  #stopUser = null;
  #stopped = false;
  #lastRun = null;

  constructor({ store, http, appVersion = '', deviceModel = '', clock = () => new Date(), autoDelayMs = 4000 }) {
    this.autoDelayMs = autoDelayMs;
    this.#store = store;
    this.#http = http;
    this.appVersion = appVersion;
    this.deviceModel = deviceModel;
    this.clock = clock;
  }

  // ---- what the screens read ------------------------------------------------------------

  /** { linked, connected, needsSignIn, busy, account, lastSyncAt, lastError, pending, refused } */
  get status() {
    const s = this.#store.syncState ?? {};

    return {
      linked: Boolean(s.linked),
      connected: Boolean(s.token),
      needsSignIn: Boolean(s.linked && !s.token),
      busy: this.#busy,
      account: s.account ?? null,
      lastSyncAt: s.last_sync_at ?? null,
      lastError: s.last_error ?? null,
      pending: this.#store.unsyncedCount,
      refused: this.#store.refused,
    };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of [...this.#listeners]) listener(this.status);
  }

  // ---- life ------------------------------------------------------------------------------

  /** Starts watching the person's changes: a save or a delete schedules a sync a few seconds later. */
  start() {
    this.#stopped = false;
    this.#stopUser = this.#store.onUserChange(() => this.schedule());
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#stopUser?.();
    this.#listeners.clear();
  }

  schedule(delay = this.autoDelayMs) {
    if (this.#stopped || !this.status.connected) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.syncNow(), delay);
  }

  // ---- connect / sign out --------------------------------------------------------------------

  /**
   * Signs in to the office. Returns the account { name, employee_code, phone }. Throws SyncError (wrong password ...).
   * `confirm(account)` may ask the person before anything is saved; answering no signs the new token out again and
   * throws SyncError('CANCELLED').
   */
  async connect({ login, password, confirm = null }) {
    const answer = await this.#http.post('/auth/login', { login, password, app_version: this.appVersion, device_model: this.deviceModel });

    if (confirm && !(await confirm(answer.account))) {
      try {
        await this.#http.post('/auth/logout', {}, { token: answer.token });
      } catch {
        // offline again: the token simply expires on the server
      }
      throw new SyncError('CANCELLED', 'Cancelled.');
    }

    const before = this.#store.syncState;
    const sameAccount = before?.account?.employee_code && before.account.employee_code === answer.account?.employee_code;

    await this.#store.saveSyncState({
      linked: true,
      token: answer.token,
      expires_at: answer.expires_at ?? null,
      account: answer.account,
      cursor: sameAccount ? (before.cursor ?? null) : null, // another account starts from the beginning
      last_error: null,
    });
    this.#emit();

    return answer.account;
  }

  /** Signs out of the office (the phone's own data stays). The office is told on a best-effort basis. */
  async signOut() {
    const token = this.#store.syncState?.token;

    if (token) {
      try {
        await this.#http.post('/auth/logout', {}, { token });
      } catch {
        // offline: the token simply expires on the server
      }
    }

    await this.#store.saveSyncState({ token: null, last_error: null });
    this.#emit();
  }

  // ---- one sync ------------------------------------------------------------------------------

  async syncNow() {
    if (this.#stopped || !this.status.connected) return this.#lastRun;
    if (this.#busy) {
      this.#again = true;
      return this.#lastRun;
    }

    this.#busy = true;
    clearTimeout(this.#timer);
    this.#emit();

    const summary = { pushed: 0, refused: 0, pulled: 0, billsUp: 0, billsDown: 0, fullPull: false };

    try {
      await this.#push(summary);
      await this.#uploadBills(summary);
      await this.#pull(summary);
      await this.#downloadBills(summary);

      await this.#store.saveSyncState({ last_sync_at: this.clock().toISOString(), last_error: null });
    } catch (error) {
      await this.#fail(error);
    } finally {
      this.#busy = false;
      this.#lastRun = summary;
      this.#emit();

      if (this.#again && !this.#stopped) {
        this.#again = false;
        this.schedule(1000);
      }
    }

    return summary;
  }

  // What went wrong, in words a rep understands. The token is dropped only when the office says it is no good.
  async #fail(error) {
    const code = error instanceof SyncError ? error.code : 'UNKNOWN';
    let patch;

    if (code === 'UNAUTHENTICATED') patch = { token: null, last_error: 'Please sign in to the office again.' };
    else if (code === 'ACCOUNT_INACTIVE') patch = { token: null, last_error: 'Your account is switched off. Please contact your manager.' };
    else if (code === 'TOO_MANY_REQUESTS') patch = { last_error: 'The office is busy. It will try again in a minute.' };
    else if (code === 'OFFLINE') patch = { last_error: 'Could not reach the office. It will try again later.' };
    else patch = { last_error: error instanceof SyncError ? error.message : 'Sync stopped because of an unexpected problem.' };

    try {
      await this.#store.saveSyncState(patch);
    } catch {
      // the app was locked while the sync ran: nothing to record
    }
  }

  // ---- push ------------------------------------------------------------------------------------

  async #push(summary) {
    const limit = 300;

    for (let round = 0; round < PUSH_ROUNDS; round++) {
      const sent = {};
      const body = { app_version: this.appVersion, device_model: this.deviceModel, deleted: {} };
      let any = false;

      for (const { kind, wire } of KINDS) {
        sent[kind] = this.#store.dirty(kind).slice(0, limit);
        body[wire] = sent[kind].map(wireOf[kind]);
        const gone = this.#store.tombstones.filter((t) => t.kind === kind).slice(0, limit);
        sent[`${kind}:deleted`] = gone;
        body.deleted[wire] = gone.map((t) => t.id);
        any ||= sent[kind].length > 0 || gone.length > 0;
      }
      if (!any) return;

      const answer = await this.#http.post('/sync/push', body, { token: this.#token() });
      let progressed = 0;

      for (const { kind, wire } of KINDS) {
        const results = new Map((answer.results?.[wire] ?? []).map((r) => [r.uuid, r]));

        for (const record of sent[kind]) {
          const result = results.get(record.id);

          if (result?.status === 'accepted' || result?.status === 'duplicate') {
            await this.#store.markSynced(kind, record.id, record.updated_at);
            summary.pushed++;
            progressed++;
          } else if (result?.status === 'rejected' && result.code === 'LOCKED') {
            // the office already decided on it: take the office's version
            await this.#store.markSynced(kind, record.id, record.updated_at);
            summary.fullPull = true;
            progressed++;
          } else if (result?.status === 'rejected' && ['INVALID', 'UUID_TAKEN'].includes(result.code)) {
            await this.#store.markRefused(kind, record.id, record.updated_at, result.message);
            summary.refused++;
            progressed++;
          }
          // anything else (SERVER_ERROR, no answer): stays "not sent" and is tried in the next sync
        }

        const deletes = new Map((answer.results?.deleted?.[wire] ?? []).map((r) => [r.uuid, r]));

        for (const tomb of sent[`${kind}:deleted`]) {
          const result = deletes.get(tomb.id);

          if (result?.status === 'accepted' || (result?.status === 'rejected' && ['LOCKED', 'INVALID'].includes(result.code))) {
            await this.#store.clearTombstone(kind, tomb.id);
            if (result.code === 'LOCKED') summary.fullPull = true; // the office keeps it: bring it back
            progressed++;
          }
        }
      }

      if (!progressed) return; // nothing changed this round: do not loop on a problem
    }
  }

  // ---- bill photos ---------------------------------------------------------------------------------

  async #uploadBills(summary) {
    const waiting = this.#store.expenses.filter((e) => e.has_bill && !e.bill_synced && e.synced).slice(0, BILLS_PER_RUN);

    for (const expense of waiting) {
      const bytes = await this.#store.billFor(expense.id);
      if (!bytes) {
        await this.#store.markBillSynced(expense.id); // the photo is gone from the phone: nothing to send
        continue;
      }

      try {
        await this.#http.post('/uploads/bill', { expense_uuid: expense.id, data_base64: toBase64(bytes) }, { token: this.#token() });
        await this.#store.markBillSynced(expense.id);
        summary.billsUp++;
      } catch (error) {
        if (error instanceof SyncError && ['LOCKED', 'INVALID', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED'].includes(error.code)) {
          await this.#store.markBillSynced(expense.id); // the office will never take it: stop trying
        } else if (!(error instanceof SyncError && error.code === 'NOT_FOUND')) {
          throw error; // offline, expired token ...: the whole sync reports it
        }
      }
    }
  }

  async #downloadBills(summary) {
    const missing = [];
    for (const expense of this.#store.expenses) {
      if (expense.has_bill && expense.bill_synced && !(await this.#store.hasBillData(expense.id))) missing.push(expense);
      if (missing.length >= BILLS_PER_RUN) break;
    }

    for (const expense of missing) {
      try {
        const answer = await this.#http.get(`/expenses/${expense.id}/bill`, { token: this.#token() });
        await this.#store.saveBillFromServer(expense.id, fromBase64(String(answer.data_base64 ?? '')));
        summary.billsDown++;
      } catch (error) {
        // a photo the phone could not get is not fatal: the expense stays readable without it
        if (!(error instanceof SyncError && ['NOT_FOUND', 'INVALID'].includes(error.code))) throw error;
      }
    }
  }

  // ---- pull ---------------------------------------------------------------------------------------

  async #pull(summary) {
    let since = summary.fullPull ? null : (this.#store.syncState?.cursor ?? null);

    for (let page = 0; page < PULL_PAGES; page++) {
      const answer = await this.#http.get('/sync/pull', { token: this.#token(), query: since ? { since } : {} });
      const deleting = new Set(this.#store.tombstones.map((t) => `${t.kind}:${t.id}`));

      for (const { kind, wire } of KINDS) {
        for (const incoming of answer[wire] ?? []) {
          if (await this.#merge(kind, incoming, deleting)) summary.pulled++;
        }
      }

      since = typeof answer.cursor === 'string' ? answer.cursor : since;
      await this.#store.saveSyncState({ cursor: since });

      if (answer.has_more !== true) return;
    }
  }

  async #merge(kind, incoming, deleting) {
    const id = typeof incoming?.uuid === 'string' ? incoming.uuid : null;
    if (!id || deleting.has(`${kind}:${id}`)) return false; // the person deleted it and the office has not heard yet

    const local = this.#store.getRecord(kind, id);

    if (incoming.deleted === true) {
      if (local && local.synced) {
        await this.#store.removeFromServer(kind, id);
        return true;
      }
      return false;
    }

    let cleaned = CLEANERS[kind](incoming);
    if (!cleaned) return false;

    const action = decide(kind, local, cleaned);
    if (action === 'keep') return false;

    if (kind === 'expense') cleaned = keepPendingBill(local, cleaned);
    await this.#store.putFromServer(kind, cleaned);
    return true;
  }

  #token() {
    const token = this.#store.syncState?.token;
    if (!token) throw new SyncError('UNAUTHENTICATED', 'Please sign in to the office again.');
    return token;
  }
}
