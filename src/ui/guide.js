import { TIERS, brandLine, groupsOf, searchProducts, tierOf } from '../core/guide.js';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { businessInput } from './inputs.js';
import { dialog, field, openPage, toast, validate } from './kit.js';
import { empty, fill, head } from './parts.js';

// The product guide: one list for the whole team, written by the manager on the website and kept on every phone (it works offline).
// A rep opens it before a visit: which brands fit a big, a middle or a small budget, what to ask, what goes wrong early and late.
// Reps only read it; to get something added or corrected they send the manager a request.
// It is a tab of its own (the "Guide" button in the dock), with one search for the whole guide.

const SHOWN = 80;

// What the rep typed / chose stays while the screen is redrawn (a sync finishing) and while another tab is looked at.
const view = { query: '', group: '', tier: '' };

export function resetGuideView() {
  view.query = '';
  view.group = '';
  view.tier = '';
}

const paragraphs = (text) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => h('p', null, line));
const bullets = (list) => h('ul', { class: 'bullets' }, list.map((line) => h('li', null, line)));

// ---- the Guide tab: the global search, budget and family filters, the list ----

export function renderGuide(container, app, ctx) {
  const store = app.store;

  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search a product, brand or problem', autocomplete: 'off', enterKeyHint: 'search', 'aria-label': 'Search the product guide', value: view.query,
  });
  const tierRow = h('div', { class: 'filters', role: 'group', 'aria-label': 'Budget' });
  const groupRow = h('div', { class: 'filters', role: 'group', 'aria-label': 'Product family' });
  const count = h('p', { class: 'muted small' });
  const list = h('div', { class: 'list' });

  const chip = (label, active, onclick) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(active), onclick }, label);

  const drawFilters = () => {
    tierRow.replaceChildren(
      chip('Any budget', view.tier === '', () => { view.tier = ''; draw(); }),
      ...TIERS.map((t) => chip(t.label, view.tier === t.value, () => { view.tier = view.tier === t.value ? '' : t.value; draw(); })));

    groupRow.replaceChildren(
      chip('All families', view.group === '', () => { view.group = ''; draw(); }),
      ...groupsOf(store.guideProducts).map((g) => chip(g.name, view.group === g.name, () => { view.group = view.group === g.name ? '' : g.name; draw(); })));
  };

  const rowOf = ({ product, found }) => {
    const chosen = tierOf(view.tier);
    const brands = chosen
      ? `${chosen.label}: ${brandLine(product[chosen.key])}`
      : TIERS.map((t) => `${t.label}: ${product[t.key].length ? product[t.key].join(', ') : '-'}`).join(' · ');

    return h('button', { class: 'item', type: 'button', onclick: () => openProduct(app, product.id) },
      h('span', { class: 'grow' },
        h('span', { class: 'title' }, product.name),
        h('span', { class: 'sub' }, brands),
        found ? h('span', { class: 'chip today', style: { marginTop: '6px' } }, `Found in: ${found}`) : null),
      icon('chevron', 18));
  };

  const draw = () => {
    const products = store.guideProducts;
    drawFilters();

    if (!products.length) {
      count.textContent = '';
      list.replaceChildren(empty('book', 'The guide is not on this phone yet', app.sync?.status.connected ? 'It arrives with the next sync. Open Settings > Office and press Sync now.' : 'Sign in to the office (Settings > Office) and it comes to this phone.'));
      return;
    }

    const found = searchProducts(products, view.query, { group: view.group, tier: view.tier });
    count.textContent = `${found.length} of ${products.length} products`;
    list.replaceChildren(...(found.length
      ? found.slice(0, SHOWN).map(rowOf)
      : [empty('search', 'Nothing found', 'Try one word, a brand name, or clear the filters.')]));
  };

  search.addEventListener('input', () => {
    view.query = search.value;
    draw();
  });

  const ask = h('button', { class: 'btn block', type: 'button', onclick: () => askNote(app, null) }, icon('edit', 18), 'Ask the manager to add something');

  fill(container,
    head({ eyebrow: `${store.guideProducts.length} products`, title: 'Product guide' }),
    search, tierRow, groupRow, count, list, store.guideProducts.length ? ask : null);
  ctx.fab(null);
  draw();
}

// ---- one product ----

function fold(title, content, open = false) {
  return h('details', { class: 'fold', open },
    h('summary', null, h('span', null, title), icon('chevron', 18)),
    h('div', { class: 'fold-body' }, content));
}

export function openProduct(app, id) {
  const store = app.store;
  const body = h('div', { class: 'stack' });
  const ask = h('button', { class: 'btn block', type: 'button', onclick: () => askNote(app, store.productById(id)) }, icon('edit', 18), 'Ask for a note or a correction');

  const requestsOf = () => store.notes.filter((n) => n.product_id === id).slice(0, 5);
  const stateOf = (n) => (n.sync_error ? `Not accepted: ${n.sync_error}` : n.synced ? 'Sent to your manager' : 'Waiting to be sent');

  const draw = () => {
    const p = store.productById(id);
    if (!p) {
      page.close();
      return;
    }

    const tiers = h('div', { class: 'card pad stack' },
      h('p', { class: 'eyebrow' }, 'What to suggest, by budget'),
      TIERS.map((t) => h('div', { class: 'tier' },
        h('div', { class: 'tier-head' }, h('span', { class: `chip ${t.value}` }, t.label), h('span', { class: 'muted small' }, t.hint)),
        p[t.key].length
          ? h('div', { class: 'people' }, p[t.key].map((brand) => h('span', { class: 'chip' }, brand)))
          : h('p', { class: 'muted small' }, 'No brand listed for this range.'))));

    const mine = requestsOf();

    body.replaceChildren(...[
      h('div', null,
        p.group ? h('p', { class: 'eyebrow' }, p.group) : null,
        h('h2', { style: { fontSize: '20px' } }, p.name)),
      tiers,

      p.summary || p.industries ? fold('About this product', h('div', { class: 'stack' }, ...paragraphs(p.summary), p.industries ? h('p', null, `Industries: ${p.industries}`) : null), true) : null,
      p.variants.length ? fold(`Types in the market (${p.variants.length})`, h('div', { class: 'stack' }, p.variants.map((v) => h('div', null, v.name ? h('strong', null, v.name) : null, h('p', null, v.text))))) : null,
      p.key_parameters.length ? fold('What to ask the client', bullets(p.key_parameters), true) : null,
      p.short_term_problems.length ? fold('Problems in the first 12 months', bullets(p.short_term_problems)) : null,
      p.long_term_problems.length ? fold('Problems after a year', bullets(p.long_term_problems)) : null,
      p.top_brands.length ? fold('Top brands and why', h('div', { class: 'stack' }, p.top_brands.map((b) => h('div', null, h('strong', null, b.name), b.note ? h('p', null, b.note) : null)))) : null,
      !p.summary && !p.variants.length && !p.key_parameters.length && !p.short_term_problems.length ? h('p', { class: 'muted' }, 'The manager has not written the details of this product yet. You can ask for them below.') : null,

      mine.length ? h('div', null,
        h('p', { class: 'eyebrow' }, 'Your requests for this product'),
        h('div', { class: 'list' }, mine.map((n) => h('div', { class: 'item', style: { minHeight: '56px' } }, h('span', { class: 'grow' }, h('span', { class: 'title' }, n.body), h('span', { class: 'sub' }, stateOf(n)))))))
        : null,
    ].filter(Boolean));
  };

  const stop = store.subscribe(draw);
  const page = openPage({ title: 'Product', body, footer: ask, onClose: stop });
  draw();
  return page;
}

// ---- a request to the manager ----

export function askNote(app, product) {
  const name = product ? null : field('Product', businessInput({ placeholder: 'For example Muffle Furnace' }));
  const text = field('What should be added or corrected?', h('textarea', { class: 'input', rows: 4, maxLength: 500, placeholder: 'For example: add Mettler Toledo under Premium' }));

  return dialog({
    title: product ? `Ask about ${product.name}` : 'Ask the manager',
    content: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Only the manager can change the guide. Your request goes to the office with the next sync.'), name?.el, text.el),
    buttons: [
      { label: 'Cancel', value: false },
      {
        label: 'Send',
        primary: true,
        async onclick(event, finish) {
          const ok = validate([
            [text, rules.required(text.input.value, { min: 3, max: 500, label: 'Your request' })],
            ...(name ? [[name, rules.businessName(name.input.value, { label: 'Product' })]] : []),
          ]);
          if (!ok) return;

          try {
            await app.store.saveNote({ product_id: product?.id ?? null, product_name: name?.input.value ?? '', body: text.input.value });
            toast('Sent to your manager with the next sync.');
            finish(true);
          } catch (error) {
            toast(error instanceof ValidationError ? error.message : 'Could not save your request.');
          }
        },
      },
    ],
  });
}
