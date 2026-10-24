import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { capitalize, dayString, formatDay, fromLocalInput, rupees, toLocalInput } from './format.js';
import { chipGroup, confirmDialog, field, openPage, slot, toast, validate } from './kit.js';

const TOMORROW = () => new Date(Date.now() + 86_400_000);

// 12345 paise -> "123.45", 12300 -> "123" (what the amount box shows when editing)
const plainAmount = (paise) => (paise % 100 === 0 ? String(paise / 100) : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`);

const saveButton = (label) => h('button', { class: 'btn primary block' }, label);

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

const deleteButton = (label, onDelete) => h('button', { class: 'btn danger block', onclick: onDelete }, icon('trash', 18), label);

// ---- expense -----------------------------------------------------------------

// An expense the office already approved or rejected: shown, not editable (the office decision always wins).
function openExpenseView(app, expense) {
  let billUrl = null;
  const preview = h('div', { style: { width: '100%' } });

  if (expense.has_bill) {
    app.store.billFor(expense.id).then((bytes) => {
      if (!bytes) return;
      billUrl = URL.createObjectURL(new Blob([bytes]));
      preview.replaceChildren(h('img', { class: 'bill', src: billUrl, alt: 'Bill photo' }));
    });
  }

  const line = (label, value) => h('div', { class: 'srow-box' }, h('label', null, label), h('div', { style: { padding: '0 14px 12px' } }, value));
  const approved = expense.status === 'approved';

  openPage({
    title: 'Expense',
    onClose: () => billUrl && URL.revokeObjectURL(billUrl),
    body: h('div', { class: 'stack' },
      h('div', { class: 'card pad stack' },
        h('span', { class: `chip ${expense.status}` }, capitalize(expense.status)),
        h('p', { class: 'muted small' }, approved ? 'The office approved this expense. It cannot be changed any more.' : 'The office rejected this expense. It cannot be changed any more.'),
        !approved && expense.reject_reason ? h('p', { class: 'err' }, `Reason: ${expense.reject_reason}`) : null),
      line('Category', capitalize(expense.category)),
      line('Amount', rupees(expense.amount_paise)),
      line('Date', formatDay(new Date(`${expense.expense_date}T00:00:00`))),
      expense.note ? line('Note', expense.note) : null,
      expense.has_bill ? preview : null),
  });
}

export function openExpenseForm(app, existing = null) {
  if (existing && existing.status !== 'pending') return openExpenseView(app, existing);

  const store = app.store;

  const category = chipGroup(rules.CATEGORIES.map((c) => ({ value: c, label: capitalize(c) })), existing?.category ?? 'travel');

  const amountInput = h('input', { class: 'input', type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount in rupees', value: existing ? plainAmount(existing.amount_paise) : '' });
  amountInput.addEventListener('input', () => {
    amountInput.value = amountInput.value.replace(/[^0-9.,]/g, '');
  });
  const amount = slot(h('div', { class: 'amount-card' },
    h('p', { class: 'eyebrow' }, 'Amount'),
    h('div', { class: 'amount-line' }, h('span', { class: 'cur', 'aria-hidden': 'true' }, '₹'), amountInput)), amountInput);

  const date = field('Date', h('input', { class: 'input', type: 'date', min: '2020-01-01', max: dayString(TOMORROW()), value: existing?.expense_date ?? dayString() }), null, 'row');
  const note = field('Note (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_NOTE, rows: 3, value: existing?.note ?? '' }), null, 'row');

  // bill photo
  let newBill = null;
  let removeBill = false;
  let billUrl = null;
  const preview = h('div', { style: { width: '100%' } });
  const removeBtn = h('button', {
    class: 'btn danger block small-btn',
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

  const save = saveButton('Save expense');
  save.addEventListener('click', async () => {
    const ok = validate([
      [amount, rules.amount(amountInput.value)],
      [date, rules.expenseDate(date.input.value)],
      [note, rules.optional(note.input.value, { max: rules.MAX_NOTE, label: 'Note' })],
    ]);
    if (!ok) return;

    const done = await submit(save, () => store.saveExpense({
      id: existing?.id,
      category: category.value,
      amount_paise: rules.parsePaise(amountInput.value),
      expense_date: date.input.value,
      note: note.input.value,
    }, { bill: newBill, removeBill }));

    if (done) page.close();
  });

  const page = openPage({
    title: existing ? 'Edit expense' : 'New expense',
    onClose: () => billUrl && URL.revokeObjectURL(billUrl),
    body: h('div', { class: 'stack' },
      h('div', null, h('p', { class: 'eyebrow' }, 'Category'), category.el),
      amount.el, date.el, note.el,
      h('div', { class: 'bill-drop' },
        h('div', { class: 'bill-title' }, icon('camera', 20), 'Attach bill photo'),
        preview,
        h('div', { class: 'grid2' },
          h('button', { class: 'btn small-btn', onclick: () => pick('camera') }, icon('camera', 18), 'Camera'),
          h('button', { class: 'btn small-btn', onclick: () => pick('gallery') }, icon('image', 18), 'Gallery')),
        removeBtn),
      existing ? deleteButton('Delete expense', async () => {
        if (await confirmDialog({ title: 'Delete this expense?', text: 'The bill photo is deleted too. This cannot be undone.' })) {
          await store.deleteExpense(existing.id);
          page.close();
        }
      }) : null),
    footer: save,
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

  const save = saveButton('Save client');
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
      name.el, company.el, phone.el, city.el, notes.el,
      existing ? deleteButton('Delete client', async () => {
        if (await confirmDialog({ title: `Delete ${existing.name}?`, text: 'Old meetings keep the name. This cannot be undone.' })) {
          await store.deleteClient(existing.id);
          page.close();
        }
      }) : null),
    footer: save,
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
  const when = field('When', h('input', { class: 'input', type: 'datetime-local', min: '2020-01-01T00:00', max: toLocalInput(TOMORROW()), value: toLocalInput(existing ? new Date(existing.meeting_at) : new Date()) }), null, 'row');
  const purpose = field('Purpose (optional)', h('input', { class: 'input', type: 'text', maxLength: rules.MAX_TEXT, autocomplete: 'off', value: existing?.purpose ?? '' }));
  const discussion = field('What was discussed (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_LONG_TEXT, rows: 5, value: existing?.discussion ?? '' }));
  const outcome = field('Outcome (optional)', h('input', { class: 'input', type: 'text', maxLength: rules.MAX_TEXT, autocomplete: 'off', value: existing?.outcome ?? '' }));
  const followup = field('Follow-up (optional)', h('input', { class: 'input', type: 'datetime-local', value: existing?.next_followup_at ? toLocalInput(new Date(existing.next_followup_at)) : '' }), null, 'row');
  const clearFollowup = h('button', { class: 'link', onclick: () => { followup.input.value = ''; } }, 'Remove follow-up');

  const syncTyped = () => { typed.el.hidden = client.input.value !== OTHER; };
  client.input.addEventListener('change', () => {
    syncTyped();
    client.setError(null);
  });
  syncTyped();

  const save = saveButton('Save meeting');
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
      client.el, typed.el, when.el, purpose.el, discussion.el, outcome.el, followup.el, clearFollowup,
      existing ? deleteButton('Delete meeting', async () => {
        if (await confirmDialog({ title: 'Delete this meeting?', text: `Meeting with ${existing.client_name} on ${formatDay(new Date(existing.meeting_at))}.` })) {
          await store.deleteMeeting(existing.id);
          page.close();
        }
      }) : null),
    footer: save,
  });
}
