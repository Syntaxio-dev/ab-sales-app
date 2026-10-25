import { normalizePhone } from '../core/phone.js';
import { positionKey } from '../core/positions.js';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { confirmDialog, dialog, field, openPage, toast, validate } from './kit.js';

// The people at a client: the form, the position dropdown (with "add a new position") and the call button.
// Kept apart from forms.js because both the client page and the meeting form use it.

const NEW_POSITION = '__new__';

// "98765 43210" -> "+919876543210" (the same spelling the store keeps)
const rulesNumber = (text) => normalizePhone(text) ?? '';

// A button that opens the phone's dialer with the number typed in (the rep presses the green button there).
// No CALL_PHONE permission is needed for that.
export function callButton(number, label = 'Call') {
  return h('a', { class: 'call-btn', href: `tel:${number}`, 'aria-label': `${label} ${number}`, onclick: (event) => event.stopPropagation() }, icon('phone', 20));
}

// A dropdown of the shared position list. The last entry adds a new position (it joins the list for the whole team).
export function positionField(app, initial = '', label = 'Position (optional)') {
  const select = h('select', { class: 'input' });
  let current = String(initial ?? '').trim();

  const draw = () => {
    const names = [...app.store.positions];
    if (current && !names.some((n) => positionKey(n) === positionKey(current))) names.push(current); // an old value that is not in the list any more

    const match = names.find((n) => positionKey(n) === positionKey(current)) ?? '';
    select.replaceChildren(
      h('option', { value: '' }, 'Not known'),
      ...names.map((name) => h('option', { value: name }, name)),
      h('option', { value: NEW_POSITION }, '+ Add a new position...'),
    );
    select.value = match;
  };

  select.addEventListener('change', async () => {
    if (select.value !== NEW_POSITION) {
      current = select.value;
      return;
    }

    const added = await askNewPosition(app);
    if (added) current = added;
    draw();
  });

  draw();
  const f = field(label, select);

  return { ...f, get value() { return current; } };
}

async function askNewPosition(app) {
  const input = h('input', { class: 'input', type: 'text', maxLength: 60, autocomplete: 'off', autocapitalize: 'words', placeholder: 'For example Plant Chemist', 'aria-label': 'New position' });
  const error = h('p', { class: 'err', role: 'alert' });

  return dialog({
    title: 'New position',
    content: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'It is added to the list for the whole team.'), input, error),
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Add',
        primary: true,
        async onclick(event, finish) {
          const problem = rules.position(input.value);
          if (problem) return void (error.textContent = problem);

          try {
            finish(await app.store.addPosition(input.value));
          } catch (e) {
            error.textContent = e instanceof ValidationError ? e.message : 'Could not add it.';
          }
        },
      },
    ],
  });
}

const submitting = async (button, work) => {
  button.disabled = true;
  try {
    await work();
    return true;
  } catch (error) {
    toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    button.disabled = false;
    return false;
  }
};

// A person at a client. `number` pre-fills the phone box (a number picked from the call history).
export function openContactForm(app, { client, existing = null, number = '', onSaved = null }) {
  const store = app.store;

  const name = field('Name', h('input', { class: 'input', type: 'text', maxLength: 150, autocomplete: 'off', autocapitalize: 'words', value: existing?.name ?? '' }));
  const position = positionField(app, existing?.position ?? '');
  const phone = field('Phone number', h('input', { class: 'input', type: 'tel', maxLength: 20, autocomplete: 'off', placeholder: '98765 43210', value: existing?.phone ?? number }), 'Calls with this number are matched to this person.');
  const email = field('E-mail (optional)', h('input', { class: 'input', type: 'email', maxLength: 150, autocomplete: 'off', value: existing?.email ?? '' }));
  const notes = field('Notes (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_NOTE, rows: 3, value: existing?.notes ?? '' }));

  const save = h('button', { class: 'btn primary block' }, 'Save person');
  save.addEventListener('click', async () => {
    const normal = rulesNumber(phone.input.value);
    const taken = normal ? store.numberOwner(normal, { exceptContact: existing?.id }) : null;

    const ok = validate([
      [name, rules.required(name.input.value, { min: 2, max: 150, label: 'Name' })],
      [phone, rules.phone(phone.input.value) ?? (taken ? `This number is already saved under ${taken}.` : null)],
      [email, rules.optional(email.input.value, { max: 150, label: 'E-mail' })],
      [notes, rules.optional(notes.input.value, { max: rules.MAX_NOTE, label: 'Notes' })],
    ]);
    if (!ok) return;

    let saved = null;
    const done = await submitting(save, async () => {
      saved = await store.saveContact({
        id: existing?.id,
        client_id: client.id,
        name: name.input.value,
        position: position.value,
        phone: phone.input.value,
        email: email.input.value,
        notes: notes.input.value,
      });
    });

    if (done) {
      void app.refreshCalls(); // calls from the last 30 days with this number now match
      page.close();
      onSaved?.(saved);
    }
  });

  const page = openPage({
    title: existing ? 'Edit person' : 'New person',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, `At ${client.name}${client.city ? `, ${client.city}` : ''}`),
      name.el, position.el, phone.el, email.el, notes.el,
      existing && store.canDelete(existing) ? h('button', {
        class: 'btn danger block',
        async onclick() {
          if (await confirmDialog({ title: `Delete ${existing.name}?`, text: 'The person leaves the client pool for the whole team. Old meetings and calls keep the name.' })) {
            await store.deleteContact(existing.id);
            page.close();
          }
        },
      }, icon('trash', 18), 'Delete person') : null,
      existing && !store.canDelete(existing) ? h('p', { class: 'muted small' }, `Added by ${existing.created_by_code || "the office"}. Only they, or your manager, can delete this person. You can still correct the details.`) : null),
    footer: save,
  });
}

// A number from the call history that is not saved yet: pick the client (or make a new one) and say who it is.
export function openAddNumber(app, number) {
  const store = app.store;
  const NEW = '__new__';
  const clients = store.clients;

  const which = field('Client', h('select', { class: 'input' },
    clients.length ? h('option', { value: '' }, 'Choose a client') : null,
    ...clients.map((c) => h('option', { value: c.id }, c.city ? `${c.name} (${c.city})` : c.name)),
    h('option', { value: NEW }, '+ A new client')));
  which.input.value = clients.length ? '' : NEW;

  const clientName = field('New client name', h('input', { class: 'input', type: 'text', maxLength: 150, autocomplete: 'off', autocapitalize: 'words' }));
  const place = field('Place (optional)', h('input', { class: 'input', type: 'text', maxLength: 100, autocomplete: 'off', autocapitalize: 'words' }));
  const person = field('Person\'s name', h('input', { class: 'input', type: 'text', maxLength: 150, autocomplete: 'off', autocapitalize: 'words' }));
  const position = positionField(app, '');

  const showNew = () => {
    const isNew = which.input.value === NEW;
    clientName.el.hidden = !isNew;
    place.el.hidden = !isNew;
  };
  which.input.addEventListener('change', showNew);
  showNew();

  const save = h('button', { class: 'btn primary block' }, 'Save number');
  save.addEventListener('click', async () => {
    const isNew = which.input.value === NEW;
    const taken = store.numberOwner(number);

    const ok = validate([
      [which, which.input.value === '' ? 'Choose a client, or add a new one.' : null],
      [clientName, isNew ? rules.required(clientName.input.value, { min: 2, max: 150, label: 'Client name' }) : null],
      [place, isNew ? rules.optional(place.input.value, { max: 100, label: 'Place' }) : null],
      [person, taken ? `This number is already saved under ${taken}.` : rules.required(person.input.value, { min: 2, max: 150, label: 'Name' })],
    ]);
    if (!ok) return;

    const done = await submitting(save, async () => {
      const client = isNew ? await store.saveClient({ name: clientName.input.value, city: place.input.value }) : store.clientById(which.input.value);
      await store.saveContact({ client_id: client.id, name: person.input.value, position: position.value, phone: number });
    });

    if (done) {
      toast('Number saved. Its calls will show under the client.');
      page.close();
      void app.refreshCalls();
    }
  });

  const page = openPage({
    title: 'Save this number',
    body: h('div', { class: 'stack' },
      h('div', { class: 'card pad' }, h('p', { class: 'eyebrow' }, 'Number'), h('strong', null, number)),
      which.el, clientName.el, place.el, person.el, position.el,
      h('p', { class: 'muted small' }, 'Everybody on the team will see this person and number. Calls with it are matched from now on.')),
    footer: save,
  });
}
