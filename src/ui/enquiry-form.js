import {
  MAX_ITEMS, SOURCES, STATUSES, addBudget, askedBrands, askedProducts, daysAgo, frequentBrands, groupRupees, guideBrands, joinBrands, openEnquiriesOf,
  shortMoney, splitBrands, statusLabel, itemsSummary,
} from '../core/enquiry.js';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { formatTime, fromLocalInput, rupees, tenAmIn, toLocalInput } from './format.js';
import { businessInput, moneyInput, numberInput, personInput } from './inputs.js';
import { confirmDialog, field, openPage, slot, toast, validate } from './kit.js';
import { dateTimeInput } from './pickers.js';
import { openContactForm } from './people.js';
import { clientPicker } from './client-picker.js';
import { openEnquiryPage } from './enquiries.js';

// "New enquiry" in three short steps (Who asked, What do they want, When to follow up). Everything the rep types lives in one plain object
// (`state`), so going back never loses anything. The boxes, the rules and store.saveEnquiry are the same as ever: this file only changes
// how the form is laid out. The store still repeats every rule.

const TITLES = ['Who asked?', 'What do they want?', 'When to follow up?'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const QUICK_BUDGET = [['+50K', 50_000], ['+1L', 100_000], ['+2L', 200_000], ['+5L', 500_000]];
const MAX_QUANTITY = 100_000;
const MAX_NOTE = 500;

let counter = 0;
const uid = (prefix) => `${prefix}${++counter}`;

const lower = (text) => String(text ?? '').trim().toLowerCase();
const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const unique = (names) => [...new Map(names.map((n) => [lower(n), n])).values()];
const validDate = (text) => {
  const at = fromLocalInput(text);
  return at && !Number.isNaN(at.getTime()) ? at : null;
};
const paiseToText = (paise) => (paise === null || paise === undefined ? '' : paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));
const rupeesText = (paise) => rupees(paise).replace(/\.00$/, '');

// "Thu 29 Oct, 10:00 am"
const reminderText = (date) => `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${formatTime(date)}`;

const newItem = (i = {}) => ({
  product: i.product ?? '',
  brands: splitBrands(i.brands),
  quantity: String(i.quantity ?? 1),
  budget: paiseToText(i.budget_paise),
});

export function openEnquiryForm(app, { existing = null, preset = {} } = {}) {
  const store = app.store;
  const clients = store.clients;
  const enquiries = store.enquiries;
  const catalogue = store.guideProducts;
  const asked = askedProducts(enquiries);
  const catalogueNames = unique(catalogue.map((p) => p.name).filter(Boolean));

  const wanted = existing?.client_id ?? preset.client_id ?? null;
  const known = wanted && store.clientById(wanted) ? wanted : null;
  const maxFollow = toLocalInput(new Date(Date.now() + 2 * 365 * 86_400_000 - 86_400_000));

  const state = {
    clientId: known,
    other: !known && Boolean(existing), // a typed name that is not in the pool
    clientName: !known && existing ? existing.client_name : '',
    search: '',
    personId: existing?.contact_id && store.contactById(existing.contact_id) ? existing.contact_id : null,
    personName: !known && existing ? existing.contact_name : '',
    items: (existing?.items?.length ? existing.items : [{}]).map(newItem),
    open: 0,
    follow: existing ? (existing.next_followup_at ? 'custom' : 'none') : 'tomorrow', // tomorrow | 3days | week | custom | none
    customAt: existing?.next_followup_at ? toLocalInput(new Date(existing.next_followup_at)) : '',
    status: existing?.status ?? 'new',
    source: existing?.source ?? null,
    note: '',
  };
  if (!known) state.personId = null;

  const snap = (withWho = true) => JSON.stringify([withWho ? [state.clientId, state.other, state.clientName, state.search, state.personId, state.personName] : 0, state.items, state.follow, state.customAt, state.status, state.source, state.note]);
  const initial = snap();

  let step = known && !existing ? 1 : 0; // a client picked on its own page starts on step 2
  let maxReached = existing ? 2 : step;
  let page = null;
  const stepEls = [];
  const cards = [];

  const clientName = () => (state.clientId ? store.clientById(state.clientId)?.name ?? '' : tidy(state.clientName));

  // ---- step 1: who asked ------------------------------------------------------------------------------------------

  const whoBox = h('div', { class: 'stack' });
  const personInputEl = personInput({ placeholder: 'For example Rohit Sharma', value: state.personName });
  const personField = field('Person who asked (optional)', personInputEl);

  personInputEl.addEventListener('input', () => { state.personName = personInputEl.value; });

  // the search box and the rows come from the shared client picker (the meeting pages use it too)
  let lastClient = state.clientId;
  const whoPicker = clientPicker(app, state, {
    onPick() {
      if (state.clientId !== lastClient) state.personId = null;
      lastClient = state.clientId;
      state.personName = '';
      personInputEl.value = '';
      drawWho();
    },
  });
  const clientSlot = whoPicker.slot;

  // the warning, and the people of the chosen client
  function drawWho() {
    const parts = [];
    const chosen = state.clientId ? store.clientById(state.clientId) : null;

    if (chosen) {
      const open = openEnquiriesOf(enquiries, chosen.id, existing?.id);
      if (open.length) {
        const e = open[0];
        const text = `Open enquiry exists: ${itemsSummary(e.items, 1)}, ${statusLabel(e.status)} ${daysAgo(new Date(e.updated_at ?? e.opened_at))}${open.length > 1 ? ` · +${open.length - 1} more` : ''}`;
        parts.push(h('div', { class: 'enq-warn', role: 'status' },
          icon('alert', 18),
          h('p', { class: 'grow' }, text),
          h('button', { type: 'button', class: 'link', onclick: () => openOther(e.id) }, 'Open')));
      }

      const people = store.contactsOf(chosen.id);
      parts.push(h('div', null,
        h('p', { class: 'eyebrow' }, 'Who asked (optional)'),
        h('div', { class: 'chips quick-picks', role: 'group', 'aria-label': 'Who asked' },
          ...people.map((p) => h('button', {
            type: 'button', class: 'filter', 'aria-pressed': String(state.personId === p.id),
            onclick() {
              state.personId = state.personId === p.id ? null : p.id;
              drawWho();
            },
          }, p.position ? `${p.name} · ${p.position}` : p.name)),
          h('button', {
            type: 'button', class: 'filter with-icon', 'aria-label': 'Add a person',
            onclick: () => openContactForm(app, { client: chosen, onSaved: (p) => { state.personId = p.id; drawWho(); } }),
          }, icon('plus', 15), 'Add'))));
    } else if (state.other) {
      parts.push(personField.el);
    }

    whoBox.replaceChildren(...parts);
  }

  // "Open" in the warning: the old enquiry replaces this form (after a question, when something was typed)
  async function openOther(id) {
    if (snap(false) !== initialWithoutWho && !(await confirmDialog({ title: 'Leave this form?', text: 'What you typed here is not saved.', yes: 'Leave' }))) return;
    page.close();
    openEnquiryPage(app, id);
  }

  // ---- step 2: what do they want ----------------------------------------------------------------------------------

  const itemsBox = h('div', { class: 'stack' });
  const totalLine = h('p', { class: 'muted small enq-total' });
  const addProduct = h('button', { type: 'button', class: 'enq-add', onclick: () => addItem() }, icon('plus', 18), 'Add another product');

  const budgetPaise = (item) => {
    const text = item.budget.replace(/,/g, '').trim();
    return text === '' ? null : rules.parsePaise(text);
  };

  function makeCard(item) {
    const productInput = businessInput({ placeholder: 'For example Muffle Furnace', value: item.product });
    const product = field('Product', productInput);
    const suggestLabel = h('p', { class: 'eyebrow' });
    const suggestRow = h('div', { class: 'chips quick-picks' });
    const suggest = h('div', null, suggestLabel, suggestRow);

    // quantity: minus, the number (it can be typed), plus
    const qty = numberInput({ class: 'stepper-input', value: item.quantity, 'aria-label': 'Quantity' });
    const qtyNow = () => (/^\d+$/.test(item.quantity) && Number(item.quantity) >= 1 ? Math.min(Number(item.quantity), MAX_QUANTITY) : 1);
    const setQty = (n) => {
      item.quantity = String(Math.min(MAX_QUANTITY, Math.max(1, n)));
      qty.value = item.quantity;
      refreshHead();
    };
    qty.addEventListener('input', () => { item.quantity = qty.value; refreshHead(); });
    qty.addEventListener('blur', () => setQty(qtyNow()));
    qty.id = uid('qty');
    const stepper = h('div', { class: 'stepper' },
      h('button', { type: 'button', class: 'step-btn', 'aria-label': 'One less', onclick: () => setQty(qtyNow() - 1) }, icon('minus', 18)),
      qty,
      h('button', { type: 'button', class: 'step-btn', 'aria-label': 'One more', onclick: () => setQty(qtyNow() + 1) }, icon('plus', 18)));
    const quantity = slot(h('div', { class: 'enq-qty' }, h('label', { htmlFor: qty.id }, 'Quantity'), stepper), qty);

    // brands: chips from earlier enquiries and the guide, plus one the rep types
    let adding = false;
    const brandRow = h('div', { class: 'chips quick-picks', role: 'group', 'aria-label': 'Preferred brands' });
    const brands = slot(h('div', null, h('p', { class: 'eyebrow' }, 'Preferred brands (optional)'), h('p', { class: 'muted small' }, 'Tap to pick, or add one that is not listed.'), brandRow), brandRow);
    const hasBrand = (name) => item.brands.some((b) => lower(b) === lower(name));

    const addBrand = (raw) => {
      const name = tidy(raw.replace(/,/g, ' '));
      adding = false;
      if (name.length >= 2 && !hasBrand(name)) {
        item.brands.push(name);
        if (joinBrands(item.brands).length > 150) {
          item.brands.pop();
          brands.setError('Brands can have at most 150 characters.');
        } else {
          brands.setError(null);
        }
      }
      drawBrands();
    };

    function drawBrands() {
      // this product's brands first, then the ones the rep uses most: so the row is never empty, even before a product is picked
      const suggestions = unique([...askedBrands(enquiries, item.product), ...guideBrands(catalogue, item.product), ...frequentBrands(enquiries)]).slice(0, 8);
      const names = unique([...suggestions, ...item.brands]);
      const box = businessInput({ class: 'brand-add', placeholder: 'Brand', maxLength: 40, 'aria-label': 'Another brand', enterKeyHint: 'done' });

      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          addBrand(box.value);
        } else if (event.key === 'Escape') {
          event.stopPropagation();
          adding = false;
          drawBrands();
        }
      });
      box.addEventListener('blur', () => adding && addBrand(box.value));

      brandRow.replaceChildren(
        ...names.map((name) => h('button', {
          type: 'button', class: 'filter', 'aria-pressed': String(hasBrand(name)),
          onclick() {
            item.brands = hasBrand(name) ? item.brands.filter((b) => lower(b) !== lower(name)) : [...item.brands, name];
            brands.setError(null);
            drawBrands();
          },
        }, name)),
        adding ? box : h('button', {
          type: 'button', class: 'filter', 'aria-label': 'Add another brand',
          onclick() {
            adding = true;
            drawBrands();
            brandRow.querySelector('.brand-add')?.focus();
          },
        }, icon('plus', 15), 'Add brand'));
    }

    // budget: a big rupee box; the chips add to it
    const budgetInput = moneyInput({ placeholder: '0', 'aria-label': 'Budget in rupees', value: groupRupees(item.budget) });
    const clear = h('button', { type: 'button', class: 'link enq-clear', onclick() { setBudget(''); budgetInput.focus(); } }, 'Clear');
    const setBudget = (text) => {
      item.budget = text;
      budgetInput.value = groupRupees(text);
      clear.hidden = text === '';
      refreshHead();
    };
    budgetInput.addEventListener('focus', () => { budgetInput.value = item.budget; });
    budgetInput.addEventListener('input', () => { item.budget = budgetInput.value.replace(/,/g, ''); clear.hidden = item.budget === ''; refreshHead(); });
    budgetInput.addEventListener('blur', () => { budgetInput.value = groupRupees(item.budget); });
    clear.hidden = item.budget === '';
    const budget = slot(h('div', null,
      h('div', { class: 'enq-budget-head' }, h('p', { class: 'eyebrow' }, 'Budget (optional)'), clear),
      h('div', { class: 'enq-money' }, h('span', { class: 'cur', 'aria-hidden': 'true' }, '₹'), budgetInput),
      h('div', { class: 'chips quick-picks', role: 'group', 'aria-label': 'Add to the budget' },
        QUICK_BUDGET.map(([label, amount]) => h('button', { type: 'button', class: 'filter', 'aria-label': `Add ${label.slice(1)} rupees`, onclick: () => setBudget(addBudget(item.budget, amount)) }, label)))), budgetInput);

    // the card: one open at a time, the others a row
    const label = h('span', { class: 'grow' });
    const headBtn = h('button', { type: 'button', class: 'pcard-head', onclick: () => openItem(cards.indexOf(card)) }, label, icon('chevron', 18));
    const remove = h('button', { type: 'button', class: 'link', onclick: () => removeItem(cards.indexOf(card)) }, 'Remove this product');
    const body = h('div', { class: 'stack pcard-body' }, product.el, suggest, quantity.el, brands.el, budget.el, remove);
    const el = h('div', { class: 'card pad pcard' }, headBtn, body);

    function refreshHead() {
      const money = budgetPaise(item);
      label.replaceChildren(
        h('span', { class: 'title' }, `${tidy(item.product) || 'New product'}${qtyNow() > 1 ? ` × ${qtyNow()}` : ' × 1'}`),
        money ? h('span', { class: 'sub' }, `Budget ${shortMoney(money / 100)}`) : null);
      drawTotal();
    }

    function refreshSuggest() {
      const typed = lower(item.product);
      const used = new Set(state.items.map((i) => lower(i.product)));
      const fromHistory = asked.filter((n) => !used.has(lower(n)) && (!typed || lower(n).includes(typed)));
      const fromGuide = catalogueNames.filter((n) => !used.has(lower(n)) && !asked.some((a) => lower(a) === lower(n)) && (!typed || lower(n).includes(typed)));
      const names = [...fromHistory, ...fromGuide].slice(0, 8);

      suggestLabel.textContent = fromHistory.length ? 'Asked before' : 'From your catalogue';
      suggest.hidden = !names.length;
      suggestRow.replaceChildren(...names.map((name) => h('button', {
        type: 'button', class: 'filter',
        onclick() {
          productInput.value = name;
          productInput.dispatchEvent(new Event('input', { bubbles: true }));
        },
      }, name)));
    }

    productInput.addEventListener('input', () => {
      item.product = productInput.value;
      cards.forEach((c) => c.refreshSuggest());
      drawBrands();
      refreshHead();
    });

    const card = {
      el,
      item,
      refreshSuggest,
      refreshHead,
      focus: () => productInput.focus(),
      showOpen(isOpen) {
        headBtn.hidden = isOpen;
        body.hidden = !isOpen;
        remove.hidden = cards.length < 2;
      },
      checks() {
        const money = item.budget.replace(/,/g, '').trim();
        const paise = money === '' ? null : rules.parsePaise(money);
        return [
          [product, rules.businessName(item.product, { label: 'Product' })],
          [brands, rules.businessName(joinBrands(item.brands), { label: 'Brands', requiredField: false })],
          [quantity, tidy(item.quantity) === '' ? null : rules.wholeNumber(item.quantity)],
          [budget, money !== '' && (paise === null || paise > 100_000_000_00) ? 'Write the budget as a number, for example 150000.' : null],
        ];
      },
    };

    drawBrands();
    refreshHead();
    return card;
  }

  function drawTotal() {
    const priced = state.items.map(budgetPaise).filter((p) => p);
    totalLine.hidden = priced.length < 2;
    totalLine.textContent = priced.length >= 2 ? `Total budget ${rupeesText(priced.reduce((a, b) => a + b, 0))}` : '';
  }

  function drawItems() {
    itemsBox.replaceChildren(...cards.map((c) => c.el), cards.length < MAX_ITEMS ? addProduct : null, totalLine);
    cards.forEach((c, n) => {
      c.showOpen(n === state.open);
      c.refreshSuggest();
    });
    drawTotal();
  }

  function openItem(n) {
    state.open = n;
    cards.forEach((c, i) => c.showOpen(i === n));
  }

  function addItem() {
    if (cards.length >= MAX_ITEMS) return;
    const item = newItem();
    state.items.push(item);
    cards.push(makeCard(item));
    state.open = cards.length - 1;
    drawItems();
    cards[state.open].focus();
  }

  function removeItem(n) {
    if (cards.length < 2) return;
    state.items.splice(n, 1);
    cards.splice(n, 1);
    state.open = Math.min(state.open > n ? state.open - 1 : state.open, cards.length - 1);
    drawItems();
  }

  state.items.forEach((item) => cards.push(makeCard(item)));
  drawItems();

  // ---- step 3: when to follow up ----------------------------------------------------------------------------------

  const followBox = h('div', null);
  const picker = dateTimeInput({ min: '2020-01-01T00:00', max: maxFollow, value: state.customAt || toLocalInput(tenAmIn(1)), pickerTitle: 'Follow-up', 'aria-label': 'Follow-up time' });
  picker.hidden = true;
  picker.addEventListener('change', () => {
    state.customAt = picker.value;
    state.follow = 'custom';
    drawFollow();
  });
  const followSlot = slot(followBox, picker);

  const followDate = () => {
    if (state.follow === 'tomorrow') return tenAmIn(1);
    if (state.follow === '3days') return tenAmIn(3);
    if (state.follow === 'week') return tenAmIn(7);
    return state.follow === 'custom' ? validDate(state.customAt) : null;
  };

  function drawFollow() {
    const choices = [['tomorrow', 'Tomorrow 10 am'], ['3days', 'In 3 days'], ['week', 'Next week']];
    const closed = ['won', 'lost'].includes(state.status);
    const at = followDate();

    followBox.replaceChildren(
      h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Follow-up' },
        ...choices.map(([value, text]) => h('button', {
          type: 'button', class: 'filter big', role: 'radio', 'aria-checked': String(state.follow === value),
          onclick() { state.follow = value; followSlot.setError(null); drawFollow(); },
        }, text)),
        h('button', {
          type: 'button', class: 'filter big with-icon', role: 'radio', 'aria-checked': String(state.follow === 'custom'),
          onclick() { picker.value = state.customAt || toLocalInput(tenAmIn(1)); picker.click(); },
        }, icon('calendar', 16), 'Pick date')),
      h('div', { class: 'enq-reminder', role: 'status' },
        icon('alarm', 18),
        h('p', { class: 'grow' }, closed ? 'A closed enquiry needs no reminder.' : at ? `Reminder: ${reminderText(at)}` : 'No reminder, this may be forgotten')),
      h('button', { type: 'button', class: 'link left enq-nofollow', 'aria-pressed': String(state.follow === 'none'), onclick() { state.follow = 'none'; followSlot.setError(null); drawFollow(); } }, 'No follow-up'));
  }

  const stageBox = h('div', { class: 'filters', role: 'radiogroup', 'aria-label': 'Stage' });
  function drawStage() {
    stageBox.replaceChildren(...STATUSES.map((s) => h('button', {
      type: 'button', class: 'filter', role: 'radio', 'aria-checked': String(state.status === s.value),
      onclick() { state.status = s.value; drawStage(); drawFollow(); },
    }, s.label)));
  }

  const sourceBox = h('div', { class: 'chips enq-source', role: 'group', 'aria-label': 'Came through' });
  function drawSource() {
    sourceBox.replaceChildren(...SOURCES.map((s) => h('button', {
      type: 'button', class: 'filter', 'aria-pressed': String(state.source === s.value),
      onclick() { state.source = state.source === s.value ? null : s.value; drawSource(); },
    }, s.label)));
  }

  const noteInput = h('textarea', { class: 'input', maxLength: MAX_NOTE, rows: 2, placeholder: 'For example: wants the price by Friday, will buy before Diwali', 'aria-label': 'Note' });
  noteInput.addEventListener('input', () => { state.note = noteInput.value; });
  const noteSlot = slot(h('div', null, h('p', { class: 'eyebrow' }, existing ? 'Add a note (optional)' : 'Note (optional)'), noteInput), noteInput);

  const section = (label, content, tag = null) => h('div', null, h('p', { class: 'eyebrow' }, label, tag ? h('span', { class: 'enq-new' }, tag) : null), content);

  // ---- the steps, the bar, the button ---------------------------------------------------------------------------------

  const stepHead = (n) => h('div', { class: 'enq-head' }, h('p', { class: 'eyebrow' }, `Step ${n + 1} of 3`), h('h2', { class: 'enq-title', tabindex: -1 }, TITLES[n]));

  stepEls.push(
    h('div', { class: 'stack enq-step' }, stepHead(0), whoPicker.searchBox, clientSlot.el, whoBox),
    h('div', { class: 'stack enq-step' }, stepHead(1), itemsBox),
    h('div', { class: 'stack enq-step' }, stepHead(2),
      followSlot.el, picker,
      section('Stage', stageBox),
      section('Came through', sourceBox, 'New'),
      noteSlot.el));

  const bar = h('div', { class: 'enq-progress', role: 'group', 'aria-label': 'Steps' },
    TITLES.map((title, n) => h('button', {
      type: 'button', 'aria-label': `Step ${n + 1} of 3: ${title}`,
      onclick() { if (n <= maxReached && n !== step) goStep(n); },
    })));

  const summary = h('p', { class: 'muted small enq-summary' });
  const next = h('button', { class: 'btn primary block', onclick: () => onNext() }, 'Next');
  const footer = h('div', { class: 'enq-foot' }, summary, next);

  const drawSummary = () => {
    const total = state.items.reduce((sum, item) => sum + (budgetPaise(item) ?? 0), 0);
    const n = state.items.length;
    summary.textContent = [clientName() || 'No client yet', `${n} product${n === 1 ? '' : 's'}`, total ? shortMoney(total / 100) : null].filter(Boolean).join(' · ');
  };

  function goStep(n, direction = n >= step ? 1 : -1) {
    step = n;
    stepEls.forEach((el, i) => {
      el.hidden = i !== n;
      el.classList.remove('from-right', 'from-left');
    });
    if (direction) stepEls[n].classList.add(direction > 0 ? 'from-right' : 'from-left');

    [...bar.children].forEach((b, i) => {
      b.dataset.on = String(i <= n);
      if (i === n) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    next.textContent = n === 2 ? 'Save enquiry' : 'Next';
    summary.hidden = n !== 2;
    if (n === 2) {
      drawSummary();
      drawFollow();
    }

    const scroller = stepEls[n].closest('.page-body');
    if (scroller) scroller.scrollTop = 0;
    stepEls[n].querySelector('.enq-title')?.focus({ preventScroll: true });
  }

  // what is wrong on a step, as [slot, message] pairs
  function checksOf(s) {
    if (s === 0) {
      return [
        [clientSlot, state.clientId ? null : state.other ? rules.businessName(state.clientName, { label: 'Client name' }) : 'Choose a client, or type a new client name above.'],
        [personField, state.other ? rules.personName(state.personName, { label: 'Person', requiredField: false }) : null],
      ];
    }
    if (s === 1) return cards.flatMap((c) => c.checks());

    return [
      [followSlot, state.follow === 'custom' && !validDate(state.customAt) ? 'Pick a valid date and time.' : null],
      [noteSlot, rules.optional(state.note, { max: MAX_NOTE, label: 'Note' })],
    ];
  }

  function applyStep(s) {
    if (s === 1) {
      const bad = cards.findIndex((c) => c.checks().some(([, message]) => message));
      if (bad >= 0) openItem(bad);
    }
    return validate(checksOf(s));
  }

  async function onNext() {
    if (step < 2) {
      if (!applyStep(step)) return;
      maxReached = Math.max(maxReached, step + 1);
      goStep(step + 1);
      return;
    }
    await save();
  }

  async function save() {
    const bad = [0, 1, 2].find((s) => checksOf(s).some(([, message]) => message));
    if (bad !== undefined) {
      maxReached = Math.max(maxReached, bad);
      if (bad !== step) goStep(bad);
      applyStep(bad);
      return;
    }

    const chosen = state.clientId ? store.clientById(state.clientId) : null;
    const person = chosen && state.personId ? store.contactById(state.personId) : null;
    const followAt = followDate();

    next.disabled = true;
    try {
      const saved = await store.saveEnquiry({
        id: existing?.id,
        client_id: chosen?.id ?? null,
        client_name: chosen ? chosen.name : state.clientName,
        contact_id: person?.id ?? null,
        contact_name: chosen ? (person?.name ?? '') : state.personName,
        status: state.status,
        source: state.source,
        items: state.items.map((item) => ({
          product: item.product,
          brands: joinBrands(item.brands),
          quantity: tidy(item.quantity) === '' ? 1 : Number(item.quantity),
          budget_paise: budgetPaise(item),
        })),
        next_followup_at: followAt ? followAt.toISOString() : null,
        note: state.note,
      });
      page.close();
      if (!existing) openEnquiryPage(app, saved.id);
    } catch (error) {
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
      next.disabled = false;
    }
  }

  // back: step 3 > 2 > 1 > (ask when something was typed) > close
  async function onBack(close) {
    if (step > 0) return goStep(step - 1);
    if (snap() !== initial && !(await confirmDialog({ title: existing ? 'Discard your changes?' : 'Discard this enquiry?', text: 'What you typed is not saved.', yes: 'Discard' }))) return undefined;
    return close();
  }

  const initialWithoutWho = snap(false);

  page = openPage({
    title: existing ? 'Edit enquiry' : 'New enquiry',
    subhead: bar,
    body: h('div', null, ...stepEls),
    footer,
    onBack,
  });

  drawWho();
  drawStage();
  drawSource();
  drawFollow();
  goStep(step, 0);
}
