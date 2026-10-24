import logoUrl from '../../assets/ab-logo.png';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { confirmDialog, field, validate } from './kit.js';

// A 6 digit PIN box (setup and "change PIN"): digits only, hidden, no suggestions (the keyboard must not remember a PIN).
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

// The company logo sits on white: the stylesheet blends it into the background in both themes.
const logo = () => h('img', { class: 'logo-img', src: logoUrl, alt: 'Agarwal Brothers' });

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
      h('div', { class: 'col left stack reveal' },
        h('div', { style: { display: 'grid', justifyItems: 'center', gap: '10px' } },
          logo(),
          h('p', { class: 'eyebrow', style: { margin: '6px 0 0' } }, 'Field sales'),
          h('h1', { class: 'title-xl' }, 'Welcome')),
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
  let value = '';
  let busy = false;
  let waiting = false; // the keypad is locked after too many wrong PINs
  let ticker = 0;

  const dots = Array.from({ length: 6 }, () => h('span', { class: 'pin-dot' }));
  const message = h('p', { class: 'pin-msg', role: 'status', 'aria-live': 'polite' }, '6 digits. Five wrong tries lock the keypad for a while.');
  const keys = [];

  const paint = () => dots.forEach((dot, i) => dot.classList.toggle('on', i < value.length));
  const setEnabled = (on) => keys.forEach((key) => { key.disabled = !on; });
  const say = (text, bad = false) => {
    message.textContent = text;
    message.classList.toggle('bad', bad);
  };
  const wait = (ms) => {
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
  };

  async function refreshLock() {
    clearInterval(ticker);
    const left = await app.vault.lockRemainingMs();
    waiting = left > 0;
    setEnabled(!waiting);

    if (waiting) {
      say(`Too many wrong tries. Wait ${wait(left)}.`, true);
      ticker = setInterval(async () => {
        const remaining = await app.vault.lockRemainingMs();
        if (remaining <= 0) {
          clearInterval(ticker);
          waiting = false;
          setEnabled(true);
          say('Try again.');
        } else {
          say(`Too many wrong tries. Wait ${wait(remaining)}.`, true);
        }
      }, 1000);
    }
  }

  async function submit() {
    busy = true;
    setEnabled(false);

    try {
      const result = await app.unlock(value);
      if (!result.ok) {
        value = '';
        paint();
        say(result.lockedForMs ? '' : `Wrong PIN. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.`, true);
        await refreshLock();
      }
      // when the PIN was right the app moves to the unlocked phase and this screen goes away
    } catch {
      value = '';
      paint();
      say('Could not open the data. Please try again.', true);
    } finally {
      busy = false;
      if (!waiting) setEnabled(true);
    }
  }

  function press(digit) {
    if (busy || waiting || value.length >= 6) return;
    value += digit;
    paint();
    if (value.length === 6) submit();
  }

  function backspace() {
    if (busy || waiting) return;
    value = value.slice(0, -1);
    paint();
  }

  const digitKey = (d) => {
    const key = h('button', { class: 'key', type: 'button', 'aria-label': d, onclick: () => press(d) }, d);
    keys.push(key);
    return key;
  };
  const backKey = h('button', { class: 'key action', type: 'button', 'aria-label': 'Delete last digit', onclick: backspace }, icon('backspace', 24));
  keys.push(backKey);

  // a phone with a hardware keyboard (or the browser preview) can type the digits too
  const onKey = (event) => {
    if (/^\d$/.test(event.key)) press(event.key);
    else if (event.key === 'Backspace') backspace();
  };
  document.addEventListener('keydown', onKey);

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
      h('div', { class: 'col reveal' },
        logo(),
        h('p', { class: 'eyebrow', style: { margin: '8px 0 0' } }, 'Secured on this phone'),
        h('h1', { class: 'title-xl' }, 'Enter your PIN'),
        h('div', { class: 'pin-dots', 'aria-hidden': 'true' }, dots),
        message,
        h('div', { class: 'keypad' },
          ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digitKey),
          h('span', { class: 'key blank', 'aria-hidden': 'true' }),
          digitKey('0'),
          backKey),
        forgot)),
  );

  refreshLock();

  // called when this screen is replaced
  return () => {
    clearInterval(ticker);
    document.removeEventListener('keydown', onKey);
  };
}
