import { ValidationError } from '../data/store.js';
import { SyncError } from '../sync/http.js';
import { h, icon } from './dom.js';
import { alertDialog, closeAll, confirmDialog, field, openPage, toast, validate } from './kit.js';

// Everything about the link to the office: the card on Home, the sign-in page and the Settings group.
// `app.sync` exists only while the app is unlocked AND an office server was configured when the app was built.

const MINUTE = 60_000;

export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return 'not yet';

  const age = now - t;
  if (age < MINUTE) return 'just now';
  if (age < 60 * MINUTE) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < 24 * 60 * MINUTE) return `${Math.floor(age / (60 * MINUTE))} h ago`;

  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- the card on Home -----------------------------------------------------------------------------

export function officeCard(app, ctx) {
  const box = h('div', { class: 'card pad stack' });

  const draw = () => {
    const sync = app.sync;
    const title = h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Office sync');

    if (!sync) {
      box.replaceChildren(title, h('p', { class: 'muted small' }, 'The office link is not set up in this version of the app. Use Settings > Export to share a file with your manager.'));
      return;
    }

    const s = sync.status;
    const parts = [title];

    if (!s.connected) {
      const waiting = s.pending;
      parts.push(
        h('p', { class: 'muted small' }, s.needsSignIn
          ? 'Please sign in to the office again. Your records are safe on this phone.'
          : 'Connect this phone to the office so your manager sees your expenses, meetings and clients. Your data goes over a secure connection.'),
        waiting ? h('p', { class: 'small' }, `${plural(waiting, 'change is', 'changes are')} waiting to be sent.`) : null,
        s.lastError ? h('p', { class: 'err' }, s.lastError) : null,
        h('button', { class: 'btn primary block small-btn', onclick: () => openConnect(app) }, s.needsSignIn ? 'Sign in to the office' : 'Connect to office'),
      );
    } else {
      parts.push(
        h('strong', null, s.busy ? 'Syncing...' : s.lastSyncAt ? `Synced ${ago(s.lastSyncAt)}` : 'Not synced yet'),
        h('p', { class: 'muted small' }, s.pending ? `${plural(s.pending, 'change is', 'changes are')} waiting to be sent.` : 'Everything on this phone is with the office.'),
        s.refused.length ? h('p', { class: 'err' }, `${plural(s.refused.length, 'record was', 'records were')} not accepted by the office: ${s.refused[0].message}`) : null,
        s.lastError ? h('p', { class: 'err' }, s.lastError) : null,
        h('button', { class: 'btn small-btn', disabled: s.busy, onclick: () => sync.syncNow() }, s.busy ? h('span', { class: 'spinner' }) : [icon('share', 18), 'Sync now']),
      );
    }

    box.replaceChildren(...parts.filter(Boolean)); // replaceChildren() would print the word "null" for an empty part
  };

  draw();

  if (app.sync) {
    ctx.onCleanup(app.sync.subscribe(draw));
    const ticker = setInterval(draw, 30_000); // "5 min ago" keeps moving
    ctx.onCleanup(() => clearInterval(ticker));
  }

  return box;
}

// ---- signing in -------------------------------------------------------------------------------------

export function openConnect(app) {
  if (!app.sync) return;

  const login = field('Employee code or phone', h('input', { class: 'input', type: 'text', maxLength: 100, autocomplete: 'off', autocapitalize: 'characters' }));
  const password = field('Password', h('input', { class: 'input', type: 'password', maxLength: 200, autocomplete: 'off', autocapitalize: 'off', spellcheck: false }));
  const message = h('p', { class: 'err', role: 'alert' });
  const connect = h('button', { class: 'btn primary block' }, 'Connect');

  const stored = app.store.profile;
  if (stored) login.input.value = stored.employee_code;

  // Before anything is saved: is this the right account? (and what happens to the records already on the phone)
  const confirmLink = async (account) => {
    const mine = app.store.profile;
    const waiting = app.store.unsyncedCount;
    const different = mine && mine.employee_code !== String(account.employee_code).toUpperCase();

    if (different && holdsRecords(app.store)) {
      await alertDialog(`This phone holds the records of ${mine.name}`, `You are signing in as ${account.name}. To use this phone for another rep, go to Settings > Switch to another rep first. That clears this phone and keeps everything the office already has.`);
      return false;
    }

    if (!different && !waiting) return true;

    return confirmDialog({
      title: `Sign in as ${account.name}?`,
      text: [
        different ? `This phone was set up for ${mine.employee_code} (${mine.name}), but you are signing in as ${account.employee_code}.` : null,
        waiting ? `The ${plural(waiting, 'record', 'records')} saved on this phone will be sent to the office under ${account.employee_code}.` : null,
      ].filter(Boolean).join(' '),
      yes: 'Yes, connect',
      danger: false,
    });
  };

  connect.addEventListener('click', async () => {
    message.textContent = '';
    const ok = validate([
      [login, login.input.value.trim() ? null : 'Type your employee code or phone number.'],
      [password, password.input.value ? null : 'Type your password.'],
    ]);
    if (!ok) return;

    connect.disabled = true;
    connect.replaceChildren(h('span', { class: 'spinner' }));

    try {
      const account = await app.sync.connect({ login: login.input.value.trim(), password: password.input.value, confirm: confirmLink });
      await app.store.saveProfile({ name: account.name, employeeCode: account.employee_code });

      password.input.value = '';
      toast(`Connected as ${account.name}`);
      page.close();
      app.sync.syncNow();
    } catch (error) {
      password.input.value = '';
      connect.disabled = false;
      connect.replaceChildren('Connect');

      if (error instanceof SyncError && error.code === 'CANCELLED') return;
      message.textContent = error instanceof SyncError || error instanceof ValidationError ? error.message : 'Could not connect. Please try again.';
    }
  });

  const page = openPage({
    title: 'Connect to office',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Use the employee code (or phone number) and the password your manager gave you. You only do this once on a phone.'),
      login.el, password.el, message,
      h('p', { class: 'muted small' }, 'Your PIN is not sent anywhere: it only unlocks this phone. The password is used once to sign in and is not stored.')),
    footer: connect,
  });
}

// Records of a person are on this phone (more than just the name typed at the start).
// (the client pool is shared by the whole team, so it does not count: expenses, meetings, calls and anything not sent yet do)
const holdsRecords = (store) => store.expenses.length + store.meetings.length + store.calls.length > 0 || store.unsyncedCount > 0;

// ---- another rep on the same phone ---------------------------------------------------------------------

// Sends what is waiting, then (after a clear question) erases this phone's records and signs out, ready for the next rep to sign in.
// The PIN stays. What the office has comes back when the next rep signs in.
export async function switchAccount(app) {
  if (app.sync?.status.connected && app.store.unsyncedCount > 0) await app.sync.syncNow();

  const left = app.store.unsyncedCount;
  const ok = await confirmDialog({
    title: 'Switch to another rep?',
    text: left
      ? `${left} ${left === 1 ? 'change' : 'changes'} could not be sent to the office (no network?). If you switch now they are LOST. Connect and sync first to keep them.`
      : 'This phone is signed out and cleared for the next rep. Everything the office already has comes back for whoever signs in. Your PIN stays.',
    yes: left ? 'Switch and lose them' : 'Switch',
    danger: left > 0,
  });
  if (!ok) return;

  try {
    await app.switchAccount({ discard: left > 0 });
  } catch (error) {
    toast(error instanceof ValidationError ? error.message : 'Could not switch. Please try again.');
    return;
  }

  closeAll();
  toast('Ready for the next rep');
  openConnect(app);
}

// ---- the Settings group ------------------------------------------------------------------------------

export function officeSettings(app, onCleanup) {
  const box = h('div', { class: 'card' });

  const row = (iconName, title, sub, onclick) =>
    h('button', { class: 'item', onclick },
      h('span', { class: 'tile-icon' }, icon(iconName, 20)),
      h('span', { class: 'grow' }, h('span', { class: 'title' }, title), sub ? h('span', { class: 'sub' }, sub) : null));

  const draw = () => {
    const sync = app.sync;

    if (!sync) {
      box.replaceChildren(h('div', { class: 'pad muted small', style: { padding: '16px' } }, 'The office link is not set up in this version of the app.'));
      return;
    }

    const s = sync.status;

    if (!s.connected) {
      box.replaceChildren(
        row('share', s.needsSignIn ? 'Sign in to the office' : 'Connect to office', s.lastError ?? 'Send your records to your manager.', () => openConnect(app)),
        row('swap', 'Switch to another rep', 'Clears this phone for the next rep.', () => switchAccount(app)),
      );
      return;
    }

    box.replaceChildren(...[
      h('div', { class: 'item', style: { cursor: 'default' } },
        h('span', { class: 'avatar' }, (s.account?.name ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('')),
        h('span', { class: 'grow' }, h('span', { class: 'title' }, s.account?.name ?? 'Connected'), h('span', { class: 'sub' }, `${s.account?.employee_code ?? ''} · synced ${ago(s.lastSyncAt)}`))),
      row('share', s.busy ? 'Syncing...' : 'Sync now', s.lastError ?? (s.pending ? `${plural(s.pending, 'change', 'changes')} waiting` : 'Everything is with the office'), () => sync.syncNow()),
      row('swap', 'Switch to another rep', 'Clears this phone for the next rep.', () => switchAccount(app)),
      row('lock', 'Sign out of the office', 'Your records stay on this phone.', async () => {
        const ok = await confirmDialog({
          title: 'Sign out of the office?',
          text: 'Your records stay on this phone, but they are not sent to the office until you sign in again.',
          yes: 'Sign out',
          danger: false,
        });
        if (ok) await sync.signOut();
      }),
    ].filter(Boolean));
  };

  draw();

  if (app.sync) onCleanup(app.sync.subscribe(draw));

  return box;
}
