import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { confirmDialog, field, validate } from './kit.js';

// A 6 digit PIN box: digits only, hidden, no suggestions (the keyboard must not remember a PIN).
export function pinInput(placeholder = '••••••') {
  const input = h('input', {
    class: 'input pin',
    type: 'password',
    inputMode: 'numeric',
    maxLength: 6,
    placeholder,
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: false,
    enterKeyHint: 'done',
  });
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
  });
  return input;
}

const logo = () => h('div', { class: 'logo' }, icon('lock', 28));

// ---- first start: name, employee code and a PIN ----------------------------------

export function renderSetup(container, app) {
  const name = field('Your name', h('input', { class: 'input', type: 'text', maxLength: 100, autocomplete: 'off', autocapitalize: 'words' }));
  const code = field('Employee code', h('input', { class: 'input', type: 'text', maxLength: 30, autocomplete: 'off', autocapitalize: 'characters', placeholder: 'For example REP001' }));
  const pin = field('Choose a 6 digit PIN', pinInput());
  const again = field('Type the PIN again', pinInput());
  const message = h('p', { class: 'err', role: 'alert' });
  const start = h('button', { class: 'btn primary block' }, 'Start');

  code.input.addEventListener('input', () => {
    code.input.value = code.input.value.replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
  });

  start.addEventListener('click', async () => {
    message.textContent = '';
    const ok = validate([
      [name, rules.required(name.input.value, { min: 2, max: 100, label: 'Name' })],
      [code, rules.employeeCode(code.input.value)],
      [pin, rules.pin(pin.input.value)],
      [again, again.input.value === pin.input.value ? null : 'The two PINs are not the same.'],
    ]);
    if (!ok) return;

    start.disabled = true;
    start.replaceChildren(h('span', { class: 'spinner' }));
    try {
      await app.setUp({ name: name.input.value, employeeCode: code.input.value, pin: pin.input.value });
    } catch (error) {
      message.textContent = error instanceof ValidationError ? error.message : 'Could not set up the app. Please try again.';
      start.disabled = false;
      start.replaceChildren('Start');
    }
  });

  container.replaceChildren(
    h('div', { class: 'center' },
      h('div', { class: 'card stack reveal' },
        logo(),
        h('div', null, h('h1', null, 'Welcome'), h('p', { class: 'muted', style: { textAlign: 'center' } }, 'Agarwal Brothers Sales')),
        name.el, code.el, pin.el, again.el,
        h('p', { class: 'muted small' }, 'You need this PIN every time the app opens. If you forget it, the only way out is to erase the app data.'),
        message,
        start,
        h('p', { class: 'muted small' },
          'Your expenses, clients and meetings are saved on this phone only, locked with your PIN. ',
          'Nothing is sent anywhere. The app does not read your calls, messages, contacts or location.'))),
  );
}

// ---- every start, and after a minute away ------------------------------------------

export function renderLock(container, app) {
  const pin = pinInput();
  const message = h('p', { class: 'err', role: 'alert', style: { textAlign: 'center' } });
  let ticker = 0;
  let busy = false;

  const wait = (ms) => {
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
  };

  async function refreshLock() {
    clearInterval(ticker);
    const left = await app.vault.lockRemainingMs();
    pin.disabled = left > 0;

    if (left > 0) {
      message.textContent = `Too many wrong tries. Wait ${wait(left)}.`;
      ticker = setInterval(async () => {
        const remaining = await app.vault.lockRemainingMs();
        if (remaining <= 0) {
          clearInterval(ticker);
          message.textContent = '';
          pin.disabled = false;
          pin.focus();
        } else {
          message.textContent = `Too many wrong tries. Wait ${wait(remaining)}.`;
        }
      }, 1000);
    }
  }

  pin.addEventListener('input', async () => {
    if (busy || pin.value.length !== 6) return;

    busy = true;
    pin.disabled = true;
    message.textContent = '';

    try {
      const result = await app.unlock(pin.value);
      if (!result.ok) {
        pin.value = '';
        message.textContent = result.lockedForMs ? '' : `Wrong PIN. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.`;
        await refreshLock();
        if (!result.lockedForMs) pin.disabled = false;
        pin.focus();
      }
      // when the PIN was right the app moves to the unlocked phase and this screen goes away
    } catch {
      message.textContent = 'Could not open the data. Please try again.';
      pin.value = '';
      pin.disabled = false;
    } finally {
      busy = false;
    }
  });

  const forgot = h('button', {
    class: 'link',
    async onclick() {
      const ok = await confirmDialog({
        title: 'Forgot your PIN?',
        text: 'The only way out is to erase everything on this phone: all expenses, clients, meetings and photos. This cannot be undone. Anything you did not export is lost.',
        yes: 'Erase everything',
      });
      if (ok) {
        clearInterval(ticker);
        await app.eraseEverything();
      }
    },
  }, 'Forgot PIN?');

  container.replaceChildren(
    h('div', { class: 'center' },
      h('div', { class: 'card stack reveal' },
        logo(),
        h('h1', null, 'Enter your PIN'),
        pin, message,
        h('div', { style: { textAlign: 'center' } }, forgot))),
  );

  refreshLock().then(() => {
    if (!pin.disabled) pin.focus();
  });

  return () => clearInterval(ticker); // called when this screen is replaced
}
