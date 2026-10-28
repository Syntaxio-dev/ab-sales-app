import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { capitalize, dayString, formatDay, rupees } from './format.js';
import { businessInput, cityPicks, phoneField, placeInput } from './inputs.js';
import { chipGroup, confirmDialog, field, openPage, slot, toast, validate } from './kit.js';
import { dateInput } from './pickers.js';
import { openContactForm } from './people.js';


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
      line('Category', rules.categoryLabel(expense.category)),
      line('Amount', rupees(expense.amount_paise)),
      line('Date', formatDay(new Date(`${expense.expense_date}T00:00:00`))),
      expense.work_area ? line('Work area', rules.WORK_AREA_LABELS[expense.work_area]) : null,
      expense.bill_type ? line('Bill', rules.BILL_TYPE_LABELS[expense.bill_type]) : null,
      expense.note ? line('Note', expense.note) : null,
      expense.has_bill ? preview : null),
  });
}

export function openExpenseForm(app, existing = null) {
  if (existing && existing.status !== 'pending') return openExpenseView(app, existing);

  const store = app.store;

  const category = chipGroup(rules.CATEGORIES.map((c) => ({ value: c, label: rules.categoryLabel(c) })), existing?.category ?? 'travel');

  // Two answers the rep must give every time (no default, so a wrong one is never saved by not looking): where the work was, and a bill or not.
  const choice = (label, group, hint = null) => {
    const error = h('div', { class: 'err', role: 'alert' });
    group.el.classList.add('chips-2');
    return slot(h('div', { class: 'field' }, h('p', { class: 'eyebrow', style: { margin: '0 0 2px' } }, label), hint ? h('p', { class: 'muted small', style: { margin: '0 0 8px' } }, hint) : null, group.el, error), null, error);
  };
  const workGroup = chipGroup(rules.WORK_AREAS.map((w) => ({ value: w, label: { local: 'Local', outstation: 'Outstation' }[w] })), existing?.work_area ?? null, () => work.setError(null));
  const work = choice('Work area', workGroup, 'Local is in Jaipur. Outstation is outside Jaipur.');
  const billGroup = chipGroup(rules.BILL_TYPES.map((b) => ({ value: b, label: rules.BILL_TYPE_LABELS[b] })), existing?.bill_type ?? (existing?.has_bill ? 'with_bill' : null), () => {
    billChoice.setError(null);
    billZone.hidden = billGroup.value !== 'with_bill';
  });
  const billChoice = choice('Bill', billGroup);

  const amountInput = h('input', { class: 'input', type: 'text', inputMode: 'decimal', autocomplete: 'off', maxLength: 12, placeholder: '0', 'aria-label': 'Amount in rupees', value: existing ? plainAmount(existing.amount_paise) : '' });
  amountInput.addEventListener('input', () => {
    amountInput.value = amountInput.value.replace(/[^0-9.,]/g, '');
  });
  const amount = slot(h('div', { class: 'amount-card' },
    h('p', { class: 'eyebrow' }, 'Amount'),
    h('div', { class: 'amount-line' }, h('span', { class: 'cur', 'aria-hidden': 'true' }, '₹'), amountInput)), amountInput);

  const date = field('Date', dateInput({ min: '2020-01-01', max: dayString(TOMORROW()), value: existing?.expense_date ?? dayString(), pickerTitle: 'Date of the expense' }), null, 'row');
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

  // the photo box only shows when the rep says there is a bill
  const billZone = h('div', { class: 'bill-drop' },
    h('div', { class: 'bill-title' }, icon('camera', 20), 'Attach bill photo (optional)'),
    preview,
    h('div', { class: 'grid2' },
      h('button', { class: 'btn small-btn', type: 'button', onclick: () => pick('camera') }, icon('camera', 18), 'Camera'),
      h('button', { class: 'btn small-btn', type: 'button', onclick: () => pick('gallery') }, icon('image', 18), 'Gallery')),
    removeBtn);
  billZone.hidden = billGroup.value !== 'with_bill';

  showBill(null);
  if (existing?.has_bill) store.billFor(existing.id).then((bytes) => !newBill && !removeBill && showBill(bytes));

  const save = saveButton('Save expense');
  save.addEventListener('click', async () => {
    const ok = validate([
      [amount, rules.amount(amountInput.value)],
      [date, rules.expenseDate(date.input.value)],
      [work, rules.workArea(workGroup.value)],
      [billChoice, rules.billType(billGroup.value)],
      [note, rules.optional(note.input.value, { max: rules.MAX_NOTE, label: 'Note' })],
    ]);
    if (!ok) return;

    const done = await submit(save, () => store.saveExpense({
      id: existing?.id,
      category: category.value,
      amount_paise: rules.parsePaise(amountInput.value),
      expense_date: date.input.value,
      work_area: workGroup.value,
      bill_type: billGroup.value,
      note: note.input.value,
    }, { bill: newBill, removeBill }));

    if (done) page.close();
  });

  const page = openPage({
    title: existing ? 'Edit expense' : 'New expense',
    onClose: () => billUrl && URL.revokeObjectURL(billUrl),
    body: h('div', { class: 'stack' },
      h('div', null, h('p', { class: 'eyebrow' }, 'Category'), category.el),
      amount.el, date.el, work.el, billChoice.el,
      billZone,
      note.el,
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
  if (existing && !store.canEdit(existing)) { // somebody else's client: read only (the client page shows it)
    toast(`Added by ${store.addedBy(existing)}. Only they, or your manager, can change it.`);
    return;
  }

  const name = field('Client name', businessInput({ placeholder: 'For example JK Cement', value: existing?.name ?? '' }), 'The company or customer. Add the people who work there on the next screen.');
  // "company" is the old way of writing the same thing: only shown for a client that already has one
  const company = field('Group / company (optional)', businessInput({ value: existing?.company ?? '' }));
  const phone = phoneField('Main number (optional)', { value: existing?.phone ?? '', landline: true, hint: 'For example the office board number.' });
  const city = field('Place (optional)', placeInput({ placeholder: 'Town or city', value: existing?.city ?? '' }), 'The team can filter clients by place.');
  city.input.after(cityPicks(city.input));
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
      }) : null),
    footer: save,
  });
}
