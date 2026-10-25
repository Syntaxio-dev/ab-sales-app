import { STATUSES, budgetTotal, byUrgency, isOpen, itemsSummary, needsAction, statusLabel, urgency } from '../core/enquiry.js';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { formatDay, formatDayTime, formatTime, fromLocalInput, initials, rupees, toLocalInput } from './format.js';
import { businessInput, numberInput, moneyInput, personInput } from './inputs.js';
import { confirmDialog, field, openPage, toast, validate } from './kit.js';
import { empty, fill, head } from './parts.js';
import { callButton, openContactForm } from './people.js';

// Enquiries: what a client asked a rep for ("price of an oven and a furnace"), the follow-ups, and the notes until it is won or lost.
// One enquiry can ask for several products at once. The manager reads all of it on the website.

const MAX_SHOWN = 80;

// A follow-up chip: "Overdue 25 Oct", "Today 4:30 pm", "27 Oct"
export function followupChip(enquiry, now = new Date()) {
  const state = urgency(enquiry, now);

  if (state === 'idle') return h('span', { class: 'chip late' }, 'No action for days');
  if (!enquiry.next_followup_at || !isOpen(enquiry.status)) return null;

  const at = new Date(enquiry.next_followup_at);
  if (state === 'overdue') return h('span', { class: 'chip late' }, icon('alarm', 12), `Overdue ${formatDay(at).replace(/ \d{4}$/, '')}`);
  if (state === 'today') return h('span', { class: 'chip today' }, icon('alarm', 12), `Today ${formatTime(at)}`);

  return h('span', { class: 'chip' }, icon('alarm', 12), formatDay(at).replace(/ \d{4}$/, ''));
}

const statusChip = (status) => h('span', { class: `chip ${status === 'won' ? 'approved' : status === 'lost' ? 'lost' : ''}` }, statusLabel(status));

function enquiryRow(app, e, now) {
  const sub = [e.contact_name, itemsSummary(e.items, 2)].filter(Boolean).join(' · ');
  const budget = budgetTotal(e.items);

  return h('button', { class: 'item', onclick: () => openEnquiryPage(app, e.id) },
    h('span', { class: 'avatar' }, initials(e.client_name)),
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, e.client_name),
      h('span', { class: 'sub' }, sub),
      budget ? h('span', { class: 'sub' }, `Budget ${rupees(budget).replace(/\.00$/, '')}`) : null),
    h('span', { class: 'end' }, statusChip(e.status), followupChip(e, now)));
}

// ---- the tab ----------------------------------------------------------------------------------------------

let scope = null; // 'action' | 'open' | 'closed' | 'all'; null = decide when the tab opens
let query = '';

export function resetEnquiryView() {
  scope = null;
  query = '';
}

export function renderEnquiries(container, app, ctx) {
  const store = app.store;
  const now = new Date();
  const all = store.enquiries;
  const action = all.filter((e) => needsAction(e, now));
  const open = all.filter((e) => isOpen(e.status));
  if (scope === null) scope = action.length ? 'action' : 'open';

  const list = h('div', { class: 'list' });
  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Which enquiries' });

  const draw = () => {
    const chips = [['action', `Needs action${action.length ? ` (${action.length})` : ''}`], ['open', `Open (${open.length})`], ['closed', 'Closed'], ['all', 'All']];
    filters.replaceChildren(...chips.map(([value, label]) => h('button', {
      class: 'filter', 'aria-pressed': String(value === scope),
      onclick() {
        scope = value;
        draw();
      },
    }, label)));

    const q = query.trim().toLowerCase();
    const pool = scope === 'action' ? action : scope === 'open' ? open : scope === 'closed' ? all.filter((e) => !isOpen(e.status)) : all;
    const shown = pool
      .filter((e) => !q || `${e.client_name} ${e.contact_name} ${e.items.map((i) => `${i.product} ${i.brands}`).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => (scope === 'closed' || scope === 'all' ? Date.parse(b.updated_at) - Date.parse(a.updated_at) : byUrgency(a, b, now)))
      .slice(0, MAX_SHOWN);

    list.replaceChildren(...(shown.length
      ? shown.map((e) => enquiryRow(app, e, now))
      : [scope === 'action' && !q
        ? empty('check', 'Nothing needs action', 'Every follow-up is on time. Well done.')
        : empty('receipt', all.length ? 'Nothing found' : 'No enquiries yet', all.length ? 'Try another filter or word.' : 'When a client asks for a price, tap "New enquiry" and write it down with the follow-up date.')]));
  };

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search client, person or product', autocomplete: 'off', value: query, 'aria-label': 'Search enquiries' });
  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });

  draw();
  fill(container,
    head({ eyebrow: `${open.length} open`, title: 'Enquiries' }),
    all.length ? filters : null,
    all.length ? search : null,
    list);
  ctx.fab('New enquiry', () => openEnquiryForm(app));
}

// ---- the Home card: what needs action ---------------------------------------------------------------------------

export function needsActionCard(app, ctx) {
  const now = new Date();
  const items = app.store.actionableEnquiries(now);

  if (!items.length) {
    return h('div', { class: 'card pad stack' },
      h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Enquiries'),
      h('p', { class: 'muted small' }, app.store.enquiries.some((e) => isOpen(e.status)) ? 'Every follow-up is on time.' : 'No open enquiries. When a client asks for a price, write it down in the Enquiries tab.'),
      h('button', { class: 'btn small-btn', onclick: () => openEnquiryForm(app) }, icon('plus', 18), 'New enquiry'));
  }

  return h('div', null,
    h('div', { class: 'section-head', style: { marginBottom: '10px' } },
      h('p', { class: 'eyebrow' }, `Needs action (${items.length})`),
      h('button', { class: 'link', onclick: () => ctx.goTab('enquiries') }, 'View all')),
    h('div', { class: 'list' }, items.slice(0, 4).map((e) => enquiryRow(app, e, now))));
}

// ---- writing an enquiry ------------------------------------------------------------------------------------------

const tomorrowAt10 = (days = 1) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(10, 0, 0, 0);
  return d;
};

export function openEnquiryForm(app, { existing = null, preset = {} } = {}) {
  const store = app.store;
  const OTHER = '__other__';
  const clients = store.clients;
  const wanted = existing?.client_id ?? preset.client_id ?? null;
  const known = wanted && clients.some((c) => c.id === wanted);
  const startOn = known ? wanted : existing || !clients.length ? OTHER : '';

  const client = field('Client', h('select', { class: 'input' },
    clients.length && !known && !existing ? h('option', { value: '' }, 'Choose a client') : null,
    ...clients.map((c) => h('option', { value: c.id, selected: known && c.id === wanted }, c.city ? `${c.name} (${c.city})` : c.name)),
    h('option', { value: OTHER, selected: startOn === OTHER }, 'Someone else (type the name)')));
  const typedClient = field('Client name', businessInput({ value: known ? '' : existing?.client_name ?? '' }));
  const typedPerson = field('Person who asked (optional)', personInput({ value: known ? '' : existing?.contact_name ?? '' }));

  // who asked: chips of the people saved at the client (tap again to unselect)
  let person = existing?.contact_id && store.contactById(existing.contact_id) ? existing.contact_id : null;
  const people = h('div', { class: 'stack' });

  const drawPeople = () => {
    const chosen = client.input.value === OTHER ? null : store.clientById(client.input.value);
    if (!chosen) {
      people.replaceChildren();
      return;
    }

    const list = store.contactsOf(chosen.id);
    if (person && !list.some((p) => p.id === person)) person = null;

    people.replaceChildren(
      h('p', { class: 'eyebrow' }, 'Who asked (optional)'),
      list.length ? h('div', { class: 'people' }, list.map((p) => h('button', {
        type: 'button', class: 'filter', 'aria-pressed': String(person === p.id),
        onclick() {
          person = person === p.id ? null : p.id;
          drawPeople();
        },
      }, p.position ? `${p.name} · ${p.position}` : p.name))) : h('p', { class: 'muted small' }, 'Nobody is saved at this client yet.'),
      h('button', { type: 'button', class: 'link', style: { textAlign: 'left', padding: '4px 0' }, onclick: () => openContactForm(app, { client: chosen, onSaved: (p) => { person = p.id; drawPeople(); } }) }, '+ Add a person'));
  };

  const syncClient = () => {
    const other = client.input.value === OTHER;
    typedClient.el.hidden = !other;
    typedPerson.el.hidden = !other;
    drawPeople();
  };
  client.input.addEventListener('change', () => {
    syncClient();
    client.setError(null);
  });

  // the products: one block each, "+ Add another product" for more
  const asked = [...new Set(store.enquiries.flatMap((e) => e.items.map((i) => i.product)))].slice(0, 40);
  const list = h('datalist', { id: 'asked-products' }, asked.map((name) => h('option', { value: name })));
  const blocks = [];
  const itemsBox = h('div', { class: 'stack' });

  const paiseToText = (paise) => (paise === null || paise === undefined ? '' : paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

  const addBlock = (item = {}) => {
    const product = field('Product', businessInput({ list: 'asked-products', placeholder: 'For example Muffle Furnace', value: item.product ?? '' }));
    const brands = field('Preferred brands (optional)', businessInput({ placeholder: 'For example Remi, Labtech', value: item.brands ?? '' }));
    const quantity = field('Quantity', numberInput({ value: String(item.quantity ?? 1) }));
    const budget = field('Budget in rupees (optional)', moneyInput({ placeholder: 'Total for this product', value: paiseToText(item.budget_paise) }));
    const remove = h('button', { type: 'button', class: 'link', onclick() { blocks.splice(blocks.indexOf(block), 1); drawItems(); } }, 'Remove this product');
    const block = { product, brands, quantity, budget, remove, el: h('div', { class: 'card pad stack' }) };
    blocks.push(block);
  };

  const drawItems = () => {
    blocks.forEach((b, n) => {
      b.el.replaceChildren(h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, `Product ${n + 1}`), b.product.el, b.brands.el, h('div', { class: 'grid2' }, b.quantity.el, b.budget.el), blocks.length > 1 ? b.remove : null);
    });
    itemsBox.replaceChildren(...blocks.map((b) => b.el), blocks.length < 10 ? h('button', { type: 'button', class: 'btn small-btn block', onclick() { addBlock(); drawItems(); } }, icon('plus', 18), 'Add another product') : null);
  };

  (existing?.items?.length ? existing.items : [{}]).forEach((i) => addBlock(i));
  drawItems();

  const status = field('Status', h('select', { class: 'input' }, STATUSES.map((s) => h('option', { value: s.value, selected: s.value === (existing?.status ?? 'new') }, s.label))));
  const followup = field('Follow-up (the app reminds you)', h('input', { class: 'input', type: 'datetime-local', min: '2020-01-01T00:00', max: toLocalInput(new Date(Date.now() + 2 * 365 * 86_400_000 - 86_400_000)), value: existing ? (existing.next_followup_at ? toLocalInput(new Date(existing.next_followup_at)) : '') : toLocalInput(tomorrowAt10()) }), null, 'row');
  const clearFollowup = h('button', { type: 'button', class: 'link', onclick: () => { followup.input.value = ''; } }, 'No follow-up date');
  const note = field(existing ? 'Add a note (optional)' : 'First note (optional)', h('textarea', { class: 'input', maxLength: 500, rows: 3, placeholder: 'For example: wants the price by Friday, will buy before Diwali', value: '' }));

  const save = h('button', { class: 'btn primary block' }, existing ? 'Save enquiry' : 'Save enquiry');
  save.addEventListener('click', async () => {
    const other = client.input.value === OTHER;
    const chosen = other ? null : store.clientById(client.input.value);
    const clientName = chosen ? chosen.name : typedClient.input.value;
    const followAt = fromLocalInput(followup.input.value);

    const items = [];
    const checks = [
      [client, client.input.value === '' ? 'Choose a client, or pick "Someone else" and type the name.' : null],
      [typedClient, other ? rules.businessName(typedClient.input.value, { label: 'Client name' }) : null],
      [typedPerson, other ? rules.personName(typedPerson.input.value, { label: 'Person', requiredField: false }) : null],
    ];

    for (const b of blocks) {
      const qtyText = b.quantity.input.value.trim();
      const qty = qtyText === '' ? 1 : Number(qtyText);
      const budgetText = b.budget.input.value.trim();
      const paise = budgetText === '' ? null : rules.parsePaise(budgetText);

      checks.push(
        [b.product, rules.businessName(b.product.input.value, { label: 'Product' })],
        [b.brands, rules.businessName(b.brands.input.value, { label: 'Brands', requiredField: false })],
        [b.quantity, qtyText === '' ? null : rules.wholeNumber(qtyText)],
        [b.budget, budgetText !== '' && (paise === null || paise > 100_000_000_00) ? 'Write the budget as a number, for example 150000.' : null],
      );
      items.push({ product: b.product.input.value, brands: b.brands.input.value, quantity: qty, budget_paise: paise });
    }
    checks.push(
      [status, null],
      [followup, followup.input.value && !followAt ? 'Pick a valid date and time.' : null],
      [note, rules.optional(note.input.value, { max: 500, label: 'Note' })],
    );
    if (!validate(checks)) return;

    save.disabled = true;
    try {
      const person_ = chosen && person ? store.contactById(person) : null;
      const saved = await store.saveEnquiry({
        id: existing?.id,
        client_id: chosen?.id ?? null,
        client_name: clientName,
        contact_id: person_?.id ?? null,
        contact_name: chosen ? (person_?.name ?? '') : typedPerson.input.value,
        status: status.input.value,
        items,
        next_followup_at: followAt ? followAt.toISOString() : null,
        note: note.input.value,
      });
      page.close();
      if (!existing) openEnquiryPage(app, saved.id);
    } catch (error) {
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
      save.disabled = false;
    }
  });

  const page = openPage({
    title: existing ? 'Edit enquiry' : 'New enquiry',
    body: h('div', { class: 'stack' },
      client.el, typedClient.el, people, typedPerson.el,
      list, itemsBox,
      status.el, followup.el, clearFollowup, note.el),
    footer: save,
  });

  syncClient();
}

// ---- one enquiry ----------------------------------------------------------------------------------------------------

export function openEnquiryPage(app, id) {
  const store = app.store;
  const body = h('div', { class: 'stack' });
  let page = null;
  let stop = () => {};

  // the same enquiry with one thing changed (the store adds the note / status change to the timeline)
  const change = async (patch) => {
    const e = store.enquiryById(id);
    if (!e) return;

    try {
      await store.saveEnquiry({
        id: e.id, client_id: e.client_id, client_name: e.client_name, contact_id: e.contact_id, contact_name: e.contact_name, items: e.items,
        status: patch.status ?? e.status,
        next_followup_at: 'next_followup_at' in patch ? patch.next_followup_at : e.next_followup_at,
        note: patch.note ?? '',
      });
    } catch (error) {
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    }
  };

  const noteBox = h('textarea', { class: 'input', rows: 3, maxLength: 500, placeholder: 'What happened, what was said ...', 'aria-label': 'Note' });
  const followBox = h('input', { class: 'input', type: 'datetime-local', min: '2020-01-01T00:00', max: toLocalInput(new Date(Date.now() + 2 * 365 * 86_400_000 - 86_400_000)), 'aria-label': 'Follow-up time' });

  const draw = () => {
    const e = store.enquiryById(id);
    if (!e) {
      page?.close();
      return;
    }

    const now = new Date();
    const person = store.contactById(e.contact_id);
    const phone = person?.phone || store.clientById(e.client_id)?.phone;
    const budget = budgetTotal(e.items);
    const open = isOpen(e.status);
    if (document.activeElement !== followBox) followBox.value = e.next_followup_at ? toLocalInput(new Date(e.next_followup_at)) : '';

    const quick = (label, date) => h('button', { type: 'button', class: 'filter', onclick: () => change({ next_followup_at: date.toISOString() }) }, label);

    body.replaceChildren(...[
      h('div', { class: 'card pad' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('span', { class: 'avatar' }, initials(e.client_name)),
          h('div', { class: 'grow', style: { minWidth: '0' } },
            h('h2', { style: { fontSize: '19px' } }, e.client_name),
            e.contact_name ? h('p', { class: 'muted' }, `${e.contact_name}${person?.position ? ` · ${person.position}` : ''}`) : null),
          phone ? callButton(phone) : null),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } }, statusChip(e.status), followupChip(e, now), h('span', { class: 'chip' }, `Opened ${formatDay(new Date(e.opened_at))}`))),

      h('div', null,
        h('div', { class: 'section-head', style: { marginBottom: '10px' } }, h('p', { class: 'eyebrow' }, `Asked for (${e.items.length})`), h('button', { class: 'link', onclick: () => openEnquiryForm(app, { existing: e }) }, 'Edit')),
        h('div', { class: 'list' }, e.items.map((i) => h('div', { class: 'item', style: { minHeight: '56px' } },
          h('span', { class: 'grow' },
            h('span', { class: 'title' }, `${i.product}${i.quantity > 1 ? ` x ${i.quantity}` : ''}`),
            h('span', { class: 'sub' }, [i.brands ? `Brands: ${i.brands}` : null, i.budget_paise ? `Budget ${rupees(i.budget_paise).replace(/\.00$/, '')}` : null].filter(Boolean).join(' · ') || 'No brand or budget noted'))))),
        budget ? h('p', { class: 'muted small', style: { marginTop: '8px' } }, `Total budget ${rupees(budget).replace(/\.00$/, '')}`) : null),

      h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Where it stands'),
        h('div', { class: 'chips' }, STATUSES.map((s) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(s.value === e.status), onclick: () => s.value !== e.status && change({ status: s.value }) }, s.label)))),

      open ? h('div', { class: 'card pad stack' },
        h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Follow-up'),
        h('p', { class: 'muted small' }, e.next_followup_at ? `The app reminds you from ${formatDayTime(new Date(e.next_followup_at))}.` : 'No follow-up date. Set one so this does not get forgotten.'),
        h('div', { class: 'chips' }, quick('Tomorrow 10 am', tomorrowAt10(1)), quick('In 3 days', tomorrowAt10(3)), quick('Next week', tomorrowAt10(7))),
        followBox,
        h('div', { class: 'grid2' },
          h('button', { class: 'btn small-btn', onclick: () => { const at = fromLocalInput(followBox.value); if (!at) return toast('Pick a date and time first.'); change({ next_followup_at: at.toISOString() }); } }, 'Save follow-up'),
          h('button', { class: 'btn small-btn', onclick: () => change({ next_followup_at: null }) }, 'Remove it'))) : null,

      h('div', { class: 'card pad stack' },
        h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Add a note'),
        noteBox,
        h('button', { class: 'btn primary block small-btn', onclick: async () => {
          if (!noteBox.value.trim()) return toast('Write the note first.');
          await change({ note: noteBox.value });
          noteBox.value = '';
        } }, 'Add note')),

      h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Notes and status changes'),
        h('div', { class: 'list' }, [...e.timeline].reverse().map((t) => h('div', { class: 'item', style: { minHeight: '56px', cursor: 'default' } },
          h('span', { class: 'grow' },
            h('span', { class: 'title', style: { fontWeight: '600' } }, t.text || (t.status ? `Status: ${statusLabel(t.status)}` : '')),
            h('span', { class: 'sub' }, `${formatDayTime(new Date(t.at))}${t.status && t.text ? ` · ${statusLabel(t.status)}` : ''}`)))))),

      h('button', { class: 'btn danger block', onclick: async () => {
        if (await confirmDialog({ title: 'Delete this enquiry?', text: `The enquiry of ${e.client_name}, with its notes, is removed for good.` })) {
          await store.deleteEnquiry(id);
        }
      } }, icon('trash', 18), 'Delete enquiry'),
    ].filter(Boolean));
  };

  stop = store.subscribe(draw);
  draw();
  page = openPage({ title: 'Enquiry', body, onClose: () => stop() });
}
