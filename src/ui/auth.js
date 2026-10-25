import logoUrl from '../../assets/ab-logo.png';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { SyncError } from '../sync/http.js';
import { h, icon } from './dom.js';
import { loginInput } from './inputs.js';
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

// ---- first start: sign in to the office, then choose a PIN ---------------------------------

// A new phone has no account of its own. The manager makes the account on the website and gives the rep an employee code and a
// password; only that opens the app (company data stays with people the company knows). The PIN is then only the lock of THIS phone.
export function renderSignIn(container, app) {
  let office = null; // the sign-in that is waiting for a PIN (kept in memory only)

  const head = (title, ...rest) => h('div', { style: { display: 'grid', justifyItems: 'center', gap: '10px' } },
    logo(),
    h('p', { class: 'eyebrow', style: { margin: '6px 0 0' } }, 'Field sales'),
    h('h1', { class: 'title-xl' }, title),
    ...rest);

  // ---- step 1: the code and password from the manager ----
  function stepSignIn() {
    const login = field('Employee code or phone', loginInput({ placeholder: 'For example REP001' }));
    const password = field('Password', h('input', { class: 'input', type: 'password', maxLength: 200, autocomplete: 'off', autocapitalize: 'off', spellcheck: false }));
    const message = h('p', { class: 'err', role: 'alert' });
    const go = h('button', { class: 'btn primary block' }, 'Sign in');

    go.addEventListener('click', async () => {
      message.textContent = '';
      const ok = validate([
        [login, login.input.value.trim() ? null : 'Type the employee code (or phone number) your manager gave you.'],
        [password, password.input.value ? null : 'Type your password.'],
      ]);
      if (!ok) return;

      go.disabled = true;
      go.replaceChildren(h('span', { class: 'spinner' }));
      try {
        office = await app.signInToOffice(login.input.value, password.input.value);
        password.input.value = '';
        stepPin();
      } catch (error) {
        password.input.value = '';
        message.textContent = error instanceof SyncError || error instanceof ValidationError ? error.message : 'Could not sign in. Please try again.';
        go.disabled = false;
        go.replaceChildren('Sign in');
      }
    });

    container.replaceChildren(
      h('div', { class: 'center' },
        h('div', { class: 'col left stack reveal' },
          head('Welcome'),
          app.officeLogin
            ? h('p', { class: 'muted' }, 'Sign in with the employee code and password your manager gave you. Without them the app cannot be used.')
            : h('p', { class: 'err' }, 'This copy of the app is not linked to the office, so it cannot be set up. Ask your manager for the latest version.'),
          h('div', { class: 'panel' }, login.el, password.el, message, go),
          h('p', { class: 'muted small' }, 'Your expenses, clients, enquiries and meetings are saved on this phone, locked with a PIN you choose next, and sent to the office over a secure connection. The app does not read your messages, contacts or location.'))),
    );
    go.disabled = !app.officeLogin;
  }

  // ---- step 2: a PIN for this phone ----
  function stepPin() {
    const pin = field('Choose a 6 digit PIN', pinInput());
    const again = field('Type the PIN again', pinInput());
    const message = h('p', { class: 'err', role: 'alert' });
    const start = h('button', { class: 'btn primary block' }, 'Start');
    const back = h('button', { class: 'link', style: { justifySelf: 'center' } }, 'Not you? Use another account');

    back.addEventListener('click', async () => {
      const cancelled = office;
      office = null;
      stepSignIn();
      await app.discardOfficeSignIn(cancelled);
    });

    start.addEventListener('click', async () => {
      message.textContent = '';
      const ok = validate([
        [pin, rules.pin(pin.input.value)],
        [again, again.input.value === pin.input.value ? null : 'The two PINs are not the same.'],
      ]);
      if (!ok) return;

      start.disabled = true;
      start.replaceChildren(h('span', { class: 'spinner' }));
      try {
        await app.setUp({ pin: pin.input.value, office });
        office = null;
      } catch (error) {
        message.textContent = error instanceof ValidationError ? error.message : 'Could not set up the app. Please try again.';
        start.disabled = false;
        start.replaceChildren('Start');
      }
    });

    container.replaceChildren(
      h('div', { class: 'center' },
        h('div', { class: 'col left stack reveal' },
          head(`Hello, ${office.account.name.split(' ')[0]}`, h('p', { class: 'muted small' }, office.account.employee_code)),
          h('div', { class: 'panel' },
            pin.el, again.el,
            h('p', { class: 'muted small' }, 'This PIN locks this phone. You need it every time the app opens, and after a minute away. If you forget it, erase the app data and sign in again: everything the office already has comes back.'),
            message,
            start),
          back)),
    );
  }

  stepSignIn();
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
