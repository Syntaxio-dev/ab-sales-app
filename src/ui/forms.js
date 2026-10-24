import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { capitalize, dayString, formatDay, fromLocalInput, toLocalInput } from './format.js';
import { confirmDialog, field, openPage, toast, validate } from './kit.js';

const TOMORROW = () => new Date(Date.now() + 86_400_000);

// 12345 paise -> "123.45", 12300 -> "123" (what the amount box shows when editing)
const plainAmount = (paise) => (paise % 100 === 0 ? String(paise / 100) : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`);

const saveButton = (label = 'Save') => h('button', { class: 'btn primary block' }, label);

// Runs a save; shows rule errors as a toast and re-enables the button.
async function submit(button, work) {
  button.disabled = true;
  try {
    await work();
    return true;
  } catch (error) {
    toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    button.disabled = false;
    return false;
  }
}

function deleteButton(label, onDelete) {
  return h('button', { class: 'btn danger block', onclick: onDelete }, icon('trash', 18), label);
}

// ---- expense -----------------------------------------------------------------

export function openExpenseForm(app, existing = null) {
  const store = app.store;

  const category = field('Category', h('select', { class: 'input' },
    rules.CATEGORIES.map((c) => h('option', { value: c, selected: c === (existing?.category ?? 'travel') }, capitalize(c)))));
  const amount = field('Amount (₹)', h('input', { class: 'input', type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder: '450', value: existing ? plainAmount(existing.amount_paise) : '' }));
  const date = field('Date', h('input', { class: 'input', type: 'date', min: '2020-01-01', max: dayString(TOMORROW()), value: existing?.expense_date ?? dayString() }));
  const note = field('Note (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_NOTE, rows: 3, value: existing?.note ?? '' }));

  amount.input.addEventListener('input', () => {
    amount.input.value = amount.input.value.replace(/[^0-9.,]/g, '');
  });

  // bill photo
  let newBill = null;
  let removeBill = false;
  let billUrl = null;
  const preview = h('div');
  const removeBtn = h('button', {
    class: 'btn danger block',
    onclick() {
      newBill = null;
      removeBill = true;
      showBill(null);
    },
  }, icon('trash', 18), 'Remove photo');

  function showBill(bytes) {
    if (billUrl) URL.revokeObjectURL(billUrl);
    billUrl = bytes ? URL.createObjectURL(new Blob([bytes])) : null;
    preview.replaceChildren(...(bytes ? [h('img', { class: 'bill', src: billUrl, alt: 'Bill photo' })] : []));
    removeBtn.hidden = !bytes;
  }

  async function pick(source) {
    app.suspendAutoLock = true; // the camera puts this app in the background on purpose
    try {
      const bytes = await app.platform.pickPhoto(source);
      if (!bytes) return;

      const problem = !rules.imageKind(bytes) ? 'Please pick a JPG, PNG or WebP picture.' : bytes.length > rules.MAX_BILL_BYTES ? 'The picture is bigger than 5 MB. Please pick a smaller one.' : null;
      if (problem) return toast(problem);

      newBill = bytes;
      removeBill = false;
      showBill(bytes);
    } catch {
      toast('The camera or gallery could not be opened.');
    } finally {
      app.suspendAutoLock = false;
    }
  }

  showBill(null);
  if (existing?.has_bill) store.billFor(existing.id).then((bytes) => !newBill && !removeBill && showBill(bytes));

  const save = saveButton();
  save.addEventListener('click', async () => {
    const ok = validate([
      [amount, rules.amount(amount.input.value)],
      [date, rules.expenseDate(date.input.value)],
      [note, rules.optional(note.input.value, { max: rules.MAX_NOTE, label: 'Note' })],
    ]);
    if (!ok) return;

    const done = await submit(save, () => store.saveExpense({
      id: existing?.id,
      category: category.input.value,
      amount_paise: rules.parsePaise(amount.input.value),
      expense_date: date.input.value,
      note: note.input.value,
    }, { bill: newBill, removeBill }));

    if (done) page.close();
  });

  const page = openPage({
    title: existing ? 'Edit expense' : 'New expense',
    onClose: () => billUrl && URL.revokeObjectURL(billUrl),
    body: h('div', { class: 'stack' },
      category.el, amount.el, date.el, note.el,
      h('div', null,
        h('p', { class: 'eyebrow' }, 'Bill photo'),
        preview,
        h('div', { class: 'grid2', style: { marginTop: '8px' } },
          h('button', { class: 'btn', onclick: () => pick('camera') }, icon('camera', 18), 'Camera'),
          h('button', { class: 'btn', onclick: () => pick('gallery') }, icon('image', 18), 'Gallery')),
        h('div', { style: { marginTop: '8px' } }, removeBtn)),
      save,
      existing ? deleteButton('Delete expense', async () => {
        if (await confirmDialog({ title: 'Delete this expense?', text: `The bill photo is deleted too. This cannot be undone.` })) {
          await store.deleteExpense(existing.id);
          page.close();
        }
      }) : null),
  });
}

// ---- client ------------------------------------------------------------------

export function openClientForm(app, existing = null) {
  const store = app.store;

  const name = field('Name', h('input', { class: 'input', type: 'text', maxLength: 150, autocomplete: 'off', autocapitalize: 'words', value: existing?.name ?? '' }));
  const company = field('Company (optional)', h('input', { class: 'input', type: 'text', maxLength: 150, autocomplete: 'off', autocapitalize: 'words', value: existing?.company ?? '' }));
  const phone = field('Phone (optional)', h('input', { class: 'input', type: 'tel', maxLength: 20, autocomplete: 'off', placeholder: '98765 43210', value: existing?.phone ?? '' }));
  const city = field('City (optional)', h('input', { class: 'input', type: 'text', maxLength: 100, autocomplete: 'off', autocapitalize: 'words', value: existing?.city ?? '' }));
  const notes = field('Notes (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_NOTE, rows: 4, value: existing?.notes ?? '' }));

  const save = saveButton();
  save.addEventListener('click', async () => {
    const ok = validate([
      [name, rules.required(name.input.value, { min: 2, max: 150, label: 'Name' })],
      [company, rules.optional(company.input.value, { max: 150, label: 'Company' })],
      [phone, rules.phone(phone.input.value)],
      [city, rules.optional(city.input.value, { max: 100, label: 'City' })],
      [notes, rules.optional(notes.input.value, { max: rules.MAX_NOTE, label: 'Notes' })],
    ]);
    if (!ok) return;

    const done = await submit(save, () => store.saveClient({
      id: existing?.id,
      name: name.input.value,
      company: company.input.value,
      phone: phone.input.value,
      city: city.input.value,
      notes: notes.input.value,
    }));
    if (done) page.close();
  });

  const page = openPage({
    title: existing ? 'Edit client' : 'New client',
    body: h('div', { class: 'stack' },
      name.el, company.el, phone.el, city.el, notes.el, save,
      existing ? deleteButton('Delete client', async () => {
        if (await confirmDialog({ title: `Delete ${existing.name}?`, text: 'Old meetings keep the name. This cannot be undone.' })) {
          await store.deleteClient(existing.id);
          page.close();
        }
      }) : null),
  });
}

// ---- meeting -----------------------------------------------------------------

export function openMeetingForm(app, existing = null) {
  const store = app.store;
  const OTHER = '__other__';
  const clients = store.clients;
  const known = existing?.client_id && clients.some((c) => c.id === existing.client_id);

  // With saved clients the box starts on "Choose a client" (never silently on "someone else"); without any it goes straight to typing.
  const startOn = known ? existing.client_id : existing || !clients.length ? OTHER : '';
  const client = field('Client', h('select', { class: 'input' },
    clients.length && !known && !existing ? h('option', { value: '', selected: startOn === '' }, 'Choose a client') : null,
    clients.map((c) => h('option', { value: c.id, selected: known && c.id === existing.client_id }, c.company ? `${c.name} (${c.company})` : c.name)),
    h('option', { value: OTHER, selected: startOn === OTHER }, 'Someone else (type the name)')));
  const typed = field('Client name', h('input', { class: 'input', type: 'text', maxLength: 150, autocomplete: 'off', autocapitalize: 'words', value: known ? '' : existing?.client_name ?? '' }));
  const when = field('When', h('input', { class: 'input', type: 'datetime-local', min: '2020-01-01T00:00', max: toLocalInput(TOMORROW()), value: toLocalInput(existing ? new Date(existing.meeting_at) : new Date()) }));
  const purpose = field('Purpose (optional)', h('input', { class: 'input', type: 'text', maxLength: rules.MAX_TEXT, autocomplete: 'off', value: existing?.purpose ?? '' }));
  const discussion = field('What was discussed (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_LONG_TEXT, rows: 5, value: existing?.discussion ?? '' }));
  const outcome = field('Outcome (optional)', h('input', { class: 'input', type: 'text', maxLength: rules.MAX_TEXT, autocomplete: 'off', value: existing?.outcome ?? '' }));
  const followup = field('Follow-up (optional)', h('input', { class: 'input', type: 'datetime-local', value: existing?.next_followup_at ? toLocalInput(new Date(existing.next_followup_at)) : '' }));
  const clearFollowup = h('button', { class: 'link', onclick: () => { followup.input.value = ''; } }, 'Remove follow-up');

  const syncTyped = () => { typed.el.hidden = client.input.value !== OTHER; };
  client.input.addEventListener('change', syncTyped);
  syncTyped();

  const save = saveButton();
  save.addEventListener('click', async () => {
    const chosen = client.input.value === OTHER ? null : store.clientById(client.input.value);
    const clientName = chosen ? chosen.name : typed.input.value;

    const meetingAt = fromLocalInput(when.input.value);
    const followupAt = fromLocalInput(followup.input.value);

    const ok = validate([
      [client, client.input.value === '' ? 'Choose a client, or pick "Someone else" and type the name.' : null],
      [typed, client.input.value === '' || chosen ? null : rules.required(typed.input.value, { max: 150, label: 'Client name' })],
      [when, meetingAt ? null : 'Pick the date and time.'],
      [purpose, rules.optional(purpose.input.value, { max: rules.MAX_TEXT, label: 'Purpose' })],
      [discussion, rules.optional(discussion.input.value, { max: rules.MAX_LONG_TEXT, label: 'Discussion' })],
      [outcome, rules.optional(outcome.input.value, { max: rules.MAX_TEXT, label: 'Outcome' })],
      [followup, followupAt && meetingAt && followupAt < meetingAt ? 'Follow-up must be after the meeting.' : null],
    ]);
    if (!ok) return;

    const done = await submit(save, () => store.saveMeeting({
      id: existing?.id,
      client_id: chosen?.id ?? null,
      client_name: clientName,
      meeting_at: meetingAt.toISOString(),
      purpose: purpose.input.value,
      discussion: discussion.input.value,
      outcome: outcome.input.value,
      next_followup_at: followupAt ? followupAt.toISOString() : null,
    }));
    if (done) page.close();
  });

  const page = openPage({
    title: existing ? 'Edit meeting' : 'New meeting',
    body: h('div', { class: 'stack' },
      client.el, typed.el, when.el, purpose.el, discussion.el, outcome.el, followup.el, clearFollowup, save,
      existing ? deleteButton('Delete meeting', async () => {
        if (await confirmDialog({ title: 'Delete this meeting?', text: `Meeting with ${existing.client_name} on ${formatDay(new Date(existing.meeting_at))}.` })) {
          await store.deleteMeeting(existing.id);
          page.close();
        }
      }) : null),
  });
}
