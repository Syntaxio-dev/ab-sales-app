import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { pinInput } from './auth.js';
import { h, icon } from './dom.js';
import { allJson, clientsCsv, expensesCsv, meetingsCsv } from './export.js';
import { confirmDialog, dialog, openPage, toast } from './kit.js';
import { officeSettings } from './office.js';
import { getChoice, setChoice } from './theme.js';

const row = (iconName, title, sub, onclick, { danger = false } = {}) =>
  h('button', { class: 'item', onclick },
    h('span', { class: 'tile-icon', style: danger ? { color: 'var(--al-ink)' } : null }, icon(iconName, 20)),
    h('span', { class: 'grow' },
      h('span', { class: 'title', style: danger ? { color: 'var(--al-ink)' } : null }, title),
      sub ? h('span', { class: 'sub' }, sub) : null));

const group = (label, ...children) => h('div', { class: 'group' }, h('p', { class: 'eyebrow' }, label), ...children);

// System / Light / Dark. The choice is applied at once and remembered (see ui/theme.js).
function appearance() {
  const options = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Appearance' });

  const draw = () => {
    const current = getChoice();
    el.replaceChildren(...options.map(([value, label]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(value === current),
      onclick() {
        setChoice(value);
        draw();
      },
    }, label)));
  };
  draw();

  return group('Appearance', el, h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'System follows your phone\'s light or dark setting.'));
}

export function openSettings(app) {
  const profile = app.store.profile;
  const cleanups = [];

  async function exportFile(name, build, mime) {
    const ok = await confirmDialog({
      title: 'Share this file?',
      text: 'The file is NOT locked with your PIN. Anyone who gets it can read it. Share it only with your manager or office.',
      yes: 'Share',
      danger: false,
    });
    if (!ok) return;

    try {
      await app.platform.shareFile(name, build(app.store), mime);
    } catch {
      toast('The file could not be shared.');
    }
  }

  async function changePin() {
    const oldPin = pinInput('Old PIN');
    const newPin = pinInput('New PIN');
    const again = pinInput('New PIN again');
    const error = h('p', { class: 'err', role: 'alert' });

    await dialog({
      title: 'Change PIN',
      content: h('div', { class: 'stack' }, oldPin, newPin, again, error),
      buttons: [
        { label: 'Cancel', value: false },
        {
          label: 'Change',
          primary: true,
          async onclick(event, finish) {
            const problem = rules.pin(newPin.value) ?? (newPin.value !== again.value ? 'The two new PINs are not the same.' : null);
            if (problem) return void (error.textContent = problem);

            event.target.disabled = true;
            try {
              if (await app.changePin(oldPin.value, newPin.value)) {
                toast('PIN changed.');
                finish(true);
              } else {
                error.textContent = 'The old PIN is wrong.';
                event.target.disabled = false;
              }
            } catch (e) {
              error.textContent = e instanceof ValidationError ? e.message : 'Could not change the PIN.';
              event.target.disabled = false;
            }
          },
        },
      ],
    });
  }

  async function erase() {
    const typed = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'ERASE', 'aria-label': 'Type ERASE to confirm' });
    const yes = await dialog({
      title: 'Erase all data?',
      content: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'All expenses, bill photos, clients and meetings on this phone will be deleted for ever. Export first if you need them.'),
        typed),
      buttons: [
        { label: 'Cancel', value: false },
        {
          label: 'Erase',
          danger: true,
          onclick(event, finish) {
            if (typed.value.trim() === 'ERASE') finish(true);
            else toast('Type the word ERASE to confirm.');
          },
        },
      ],
    });

    if (yes) await app.eraseEverything();
  }

  openPage({
    title: 'Settings',
    onClose: () => cleanups.forEach((fn) => fn()),
    body: h('div', null,
      profile ? h('div', { class: 'card' }, h('div', { class: 'item', style: { border: 0, cursor: 'default' } },
        h('span', { class: 'avatar' }, profile.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('')),
        h('span', { class: 'grow' }, h('span', { class: 'title' }, profile.name), h('span', { class: 'sub' }, `Employee code ${profile.employee_code}`)))) : null,

      appearance(),

      group('Office', officeSettings(app, (fn) => cleanups.push(fn))),

      group('Export', h('div', { class: 'card' },
        row('share', 'Expenses (CSV)', null, () => exportFile('expenses.csv', expensesCsv, 'text/csv')),
        row('share', 'Clients (CSV)', null, () => exportFile('clients.csv', clientsCsv, 'text/csv')),
        row('share', 'Meetings (CSV)', null, () => exportFile('meetings.csv', meetingsCsv, 'text/csv')),
        row('share', 'Everything (JSON)', 'For the office system. Bill photos are not included.', () => exportFile('ab-sales-export.json', allJson, 'application/json')))),

      group('Security', h('div', { class: 'card' },
        row('key', 'Change PIN', null, changePin),
        row('lock', 'Lock now', null, () => app.lock()))),

      group('Privacy', h('div', { class: 'card pad muted small' },
        'This app saves your expenses, bill photos, clients and meetings on this phone only, encrypted and locked with your PIN. ',
        'It does not read your calls, messages, contacts or location. Only after you connect to the office, it sends your expenses, bill photos, clients and meetings to the office over a secure connection, and nothing else. ',
        'The app locks itself after a minute in the background, and hides its screen in the recent-apps list.')),

      group('Danger zone', h('div', { class: 'card' }, row('trash', 'Erase all data', 'Deletes everything on this phone and starts again.', erase, { danger: true }))),

      h('p', { class: 'muted small', style: { textAlign: 'center', marginTop: '24px' } }, `Agarwal Brothers Sales · version ${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}`)),
  });
}
