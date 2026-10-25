import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { capitalize, dayString, formatDay, fromLocalInput, rupees, toLocalInput } from './format.js';
import { businessInput, phoneField, placeInput } from './inputs.js';
import { chipGroup, confirmDialog, field, openPage, slot, toast, validate } from './kit.js';
import { openContactForm } from './people.js';

const TWO_YEARS = 2 * 365 * 86_400_000; // the office refuses a follow-up further ahead than this

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

  const amountInput = h('input', { class: 'input', type: 'text', inputMode: 'decimal', autocomplete: 'off', maxLength: 12, placeholder: '0', 'aria-label': 'Amount in rupees', value: existing ? plainAmount(existing.amount_paise) : '' });
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

  const name = field('Client name', businessInput({ placeholder: 'For example JK Cement', value: existing?.name ?? '' }), 'The company or customer. Add the people who work there on the next screen.');
  // "company" is the old way of writing the same thing: only shown for a client that already has one
  const company = field('Group / company (optional)', businessInput({ value: existing?.company ?? '' }));
  const phone = phoneField('Main number (optional)', { value: existing?.phone ?? '', landline: true, hint: 'For example the office board number.' });
  const city = field('Place (optional)', placeInput({ placeholder: 'Town or city', value: existing?.city ?? '' }), 'The team can filter clients by place.');
  company.el.hidden = !existing?.company;
  const notes = field('Notes (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_NOTE, rows: 4, value: existing?.notes ?? '' }));

  const save = saveButton('Save client');
  save.addEventListener('click', async () => {
    const taken = phone.value ? store.numberOwner(phone.value, { exceptClient: existing?.id }) : null;

    const ok = validate([
      [name, rules.businessName(name.input.value, { label: 'Name' })],
      [company, rules.businessName(company.input.value, { label: 'Company', requiredField: false })],
      [phone, phone.problem() ?? (taken ? `This number is already saved under ${taken}.` : null)],
      [city, rules.place(city.input.value, { label: 'Place' })],
      [notes, rules.optional(notes.input.value, { max: rules.MAX_NOTE, label: 'Notes' })],
    ]);
    if (!ok) return;

    let saved = null;
    const done = await submit(save, async () => {
      saved = await store.saveClient({
        id: existing?.id,
        name: name.input.value,
        company: company.input.value,
        phone: phone.value,
        city: city.input.value,
        notes: notes.input.value,
      });
    });
    if (!done) return;

    page.close();
    if (!existing) openContactForm(app, { client: saved }); // a new client: straight on to the first person at it
  });

  const page = openPage({
    title: existing ? 'Edit client' : 'New client',
    body: h('div', { class: 'stack' },
      name.el, company.el, phone.el, city.el, notes.el,
      existing && store.canDelete(existing) ? deleteButton('Delete client', async () => {
        if (await confirmDialog({ title: `Delete ${existing.name}?`, text: 'The client and the people saved under it leave the pool for the whole team. Old meetings keep the name. This cannot be undone.' })) {
          await store.deleteClient(existing.id);
          page.close();
        }
      }) : null,
      existing && !store.canDelete(existing) ? h('p', { class: 'muted small' }, `Added by ${existing.created_by_name ?? existing.created_by_code}. Only they, or your manager, can delete this client. You can still correct the details.`) : null),
    footer: save,
  });
}

// ---- meeting -----------------------------------------------------------------

export function openMeetingForm(app, existing = null, preset = {}) {
  const store = app.store;
  const OTHER = '__other__';
  const clients = store.clients;
  const wanted = existing?.client_id ?? preset.client_id ?? null;
  const known = wanted && clients.some((c) => c.id === wanted);

  // With saved clients the box starts on "Choose a client" (never silently on "someone else"); without any it goes straight to typing.
  const startOn = known ? wanted : existing || !clients.length ? OTHER : '';
  const client = field('Client', h('select', { class: 'input' },
    clients.length && !known && !existing ? h('option', { value: '', selected: startOn === '' }, 'Choose a client') : null,
    clients.map((c) => h('option', { value: c.id, selected: known && c.id === wanted }, c.city ? `${c.name} (${c.city})` : c.name)),
    h('option', { value: OTHER, selected: startOn === OTHER }, 'Someone else (type the name)')));
  const typed = field('Client name', businessInput({ value: known ? '' : existing?.client_name ?? '' }));
  const when = field('When', h('input', { class: 'input', type: 'datetime-local', min: '2020-01-01T00:00', max: toLocalInput(TOMORROW()), value: toLocalInput(existing ? new Date(existing.meeting_at) : new Date()) }), null, 'row');
  const purpose = field('Purpose (optional)', h('input', { class: 'input', type: 'text', maxLength: rules.MAX_TEXT, autocomplete: 'off', value: existing?.purpose ?? '' }));
  const discussion = field('What was discussed (optional)', h('textarea', { class: 'input', maxLength: rules.MAX_LONG_TEXT, rows: 5, value: existing?.discussion ?? '' }));
  const outcome = field('Outcome (optional)', h('input', { class: 'input', type: 'text', maxLength: rules.MAX_TEXT, autocomplete: 'off', value: existing?.outcome ?? '' }));
  const followup = field('Follow-up (optional)', h('input', { class: 'input', type: 'datetime-local', min: '2020-01-01T00:00', max: toLocalInput(new Date(Date.now() + TWO_YEARS - 86_400_000)), value: existing?.next_followup_at ? toLocalInput(new Date(existing.next_followup_at)) : '' }), null, 'row');
  const clearFollowup = h('button', { class: 'link', onclick: () => { followup.input.value = ''; } }, 'Remove follow-up');

  // the people met: chips of the people saved at the chosen client, plus a way to add one on the spot
  const met = new Set((existing?.contact_ids ?? []).filter((id) => store.contactById(id)));
  const people = h('div', { class: 'stack' });

  const drawPeople = () => {
    const chosenClient = client.input.value === OTHER ? null : store.clientById(client.input.value);
    if (!chosenClient) {
      people.replaceChildren();
      return;
    }

    const list = store.contactsOf(chosenClient.id);
    for (const id of [...met]) if (!list.some((p) => p.id === id)) met.delete(id); // a person of another client was selected before

    people.replaceChildren(
      h('p', { class: 'eyebrow' }, 'People you met (optional)'),
      list.length
        ? h('div', { class: 'people' }, list.map((p) => h('button', {
          type: 'button',
          class: 'filter',
          'aria-pressed': String(met.has(p.id)),
          onclick() {
            if (met.has(p.id)) met.delete(p.id);
            else met.add(p.id);
            drawPeople();
          },
        }, p.position ? `${p.name} · ${p.position}` : p.name)))
        : h('p', { class: 'muted small' }, 'Nobody is saved at this client yet.'),
      h('button', {
        type: 'button',
        class: 'link',
        style: { textAlign: 'left', padding: '4px 0' },
        onclick: () => openContactForm(app, { client: chosenClient, onSaved: (person) => { met.add(person.id); drawPeople(); } }),
      }, '+ Add a person I met'),
    );
  };

  const syncTyped = () => {
    typed.el.hidden = client.input.value !== OTHER;
    drawPeople();
  };
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
      [typed, client.input.value === '' || chosen ? null : rules.businessName(typed.input.value, { label: 'Client name' })],
      [when, meetingAt ? null : 'Pick the date and time.'],
      [purpose, rules.optional(purpose.input.value, { max: rules.MAX_TEXT, label: 'Purpose' })],
      [discussion, rules.optional(discussion.input.value, { max: rules.MAX_LONG_TEXT, label: 'Discussion' })],
      [outcome, rules.optional(outcome.input.value, { max: rules.MAX_TEXT, label: 'Outcome' })],
      [followup, followup.input.value && !followupAt ? 'Pick a valid date and time.' : followupAt && meetingAt && followupAt < meetingAt ? 'Follow-up must be after the meeting.' : followupAt && followupAt.getTime() > Date.now() + TWO_YEARS ? 'A follow-up can be at most 2 years ahead.' : null],
    ]);
    if (!ok) return;

    const done = await submit(save, () => store.saveMeeting({
      id: existing?.id,
      client_id: chosen?.id ?? null,
      client_name: clientName,
      contact_ids: chosen ? [...met] : [],
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
      client.el, typed.el, people, when.el, purpose.el, discussion.el, outcome.el, followup.el, clearFollowup,
      existing ? deleteButton('Delete meeting', async () => {
        if (await confirmDialog({ title: 'Delete this meeting?', text: `Meeting with ${existing.client_name} on ${formatDay(new Date(existing.meeting_at))}.` })) {
          await store.deleteMeeting(existing.id);
          page.close();
        }
      }) : null),
    footer: save,
  });
}
