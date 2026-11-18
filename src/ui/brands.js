import { TIERS, allBrands, brandNamed, brandProducts, brandTierCounts, brandTierLine, guideRivals, searchBrands, withBrandDefaults } from '../core/guide.js';
import { h, icon } from './dom.js';
import { openPage } from './kit.js';
import { empty } from './parts.js';

// The brand guide (v1.18). The manager writes, on the website, what each brand we sell is best at, how to pitch it and how to answer a
// client's doubt; the phone adds what it knows from the product guide: which of our products carry the brand, in which budget range,
// and which of our other brands sit in the same products. Read only, works offline like the rest of the guide.
//
// ui/guide.js imports this file and hands over its `openProduct` with `useProductOpener` (importing it back would be a loop).

const bullets = (list) => h('ul', { class: 'bullets' }, list.map((line) => h('li', null, line)));
const section = (title, ...content) => h('section', { class: 'guide-section' }, h('h3', { class: 'guide-h' }, title), ...content);

/** A brand name that opens the brand's page: used in the product brief's "What to suggest, by budget". */
export function brandChip(app, name, extraClass = '') {
  return h('button', { class: `chip brand-chip ${extraClass}`.trim(), type: 'button', onclick: () => openBrand(app, name), 'aria-label': `About ${name}` }, name);
}

/** One row of a brand list: name, where it sits in our guide, how many products. */
export function brandRow(app, row) {
  const products = app.store.guideProducts;
  const tierLine = brandTierLine(products, row.name);
  const count = row.count ?? brandProducts(products, row.name).length;
  const sub = [tierLine, count ? `${count} product${count === 1 ? '' : 's'}` : null, row.brand?.origin ? row.brand.origin.split('·')[0].trim() : null].filter(Boolean).join(' · ');

  return h('button', { class: 'item guide-row', type: 'button', onclick: () => openBrand(app, row.name) },
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, row.name),
      h('span', { class: 'sub' }, sub || 'Not in a product of the guide yet')),
    icon('chevron', 18));
}

/** The brands that match a search, as rows (the brand guide's brands, plus a name only found in the product lists). */
export function brandMatches(app, query) {
  const rows = allBrands(app.store.guideBrands, app.store.guideProducts);
  const brands = rows.map((r) => r.brand ?? withBrandDefaults({ id: `name:${r.name}`, name: r.name }));
  const found = new Set(searchBrands(brands, query).map((b) => b.name));
  return rows.filter((r) => found.has(r.name));
}

// ---- every brand, with a search ----

export function openBrandsPage(app) {
  const store = app.store;
  const list = h('div', { class: 'list' });
  const count = h('p', { class: 'muted small' });
  let query = '';

  const draw = () => {
    const rows = query.trim() ? brandMatches(app, query) : allBrands(store.guideBrands, store.guideProducts);
    count.textContent = `${rows.length} brand${rows.length === 1 ? '' : 's'}`;
    list.replaceChildren(...(rows.length ? rows.map((r) => brandRow(app, r)) : [empty('search', 'Nothing found', 'Try a brand name or what it makes, for example "furnace".')]));
  };

  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search brands', autocomplete: 'off', enterKeyHint: 'search', 'aria-label': 'Search brands' });
  input.addEventListener('input', () => {
    query = input.value;
    draw();
  });

  const stop = store.subscribe(draw);
  openPage({
    title: 'Brands we sell',
    body: h('div', { class: 'stack guide-page' }, h('div', { class: 'guide-search' }, icon('search', 20), input), count, list),
    onClose: stop,
  });
  draw();
}

// ---- one brand: the brand brief ----

let productOpener = null;
/** ui/guide.js hands over its `openProduct` once (a product row on the brand page opens the product brief). */
export const useProductOpener = (fn) => { productOpener = fn; };

export function openBrand(app, name) {
  const store = app.store;
  const body = h('div', { class: 'stack guide-page' });

  const draw = () => {
    const products = store.guideProducts;
    const brand = brandNamed(store.guideBrands, name);
    const title = brand?.name ?? name;
    const carried = brandProducts(products, title);
    const counts = brandTierCounts(products, title);
    const rivals = guideRivals(products, title);
    const written = brand && (brand.about || brand.known_for.length || brand.pitch.length || brand.objections.length);

    const tierChips = TIERS.filter((t) => counts[t.value]).map((t) => h('span', { class: `chip ${t.value}` }, `${t.label} · ${counts[t.value]}`));

    const productList = carried.length ? section(`In our guide (${carried.length} product${carried.length === 1 ? '' : 's'})`,
      h('div', { class: 'list' }, carried.map(({ product, tier }) => h('button', {
        class: 'item guide-row', type: 'button', onclick: () => productOpener?.(app, product.id),
      }, h('span', { class: 'grow' }, h('span', { class: 'title' }, product.name), h('span', { class: 'sub' }, `${tier.label}${product.group ? ` · ${product.group}` : ''}`)), icon('chevron', 18))))) : null;

    const hint = { premium: 'premium option', economy: 'economy option', lite: 'budget option' };
    const ourRivals = rivals.length ? section('Our other brands in the same products',
      h('p', { class: 'muted small' }, 'If the client wants a different budget, these are the brands we can offer instead.'),
      h('div', { class: 'list' }, rivals.map((r) => h('button', { class: 'item guide-row', type: 'button', onclick: () => openBrand(app, r.name) },
        h('span', { class: 'grow' }, h('span', { class: 'title' }, r.name), h('span', { class: 'sub' }, `Mostly the ${hint[r.tierHint]} · ${r.shared} shared product${r.shared === 1 ? '' : 's'}`)),
        icon('chevron', 18))))) : null;

    body.replaceChildren(...[
      h('div', { class: 'brief-title' },
        h('p', { class: 'eyebrow' }, `Brand brief${brand?.origin ? ` · ${brand.origin.split('·')[0].trim()}` : ''}`),
        h('h2', null, title),
        brand?.origin ? h('p', { class: 'lead' }, brand.origin) : null),
      tierChips.length ? h('div', { class: 'people' }, tierChips) : null,
      brand?.channel ? h('p', { class: 'muted small' }, `We buy it through: ${brand.channel}`) : null,
      brand?.about ? h('div', { class: 'card pad' }, h('p', null, brand.about)) : null,

      brand?.pitch.length ? h('section', { class: 'pitch-card' }, h('p', { class: 'eyebrow' }, 'How to pitch it'), bullets(brand.pitch)) : null,
      brand?.known_for.length ? section('Best at', bullets(brand.known_for)) : null,
      brand?.known_lines.length ? section('Best-known lines', h('div', { class: 'people' }, brand.known_lines.map((l) => h('span', { class: 'chip' }, l)))) : null,
      brand?.best_for.length ? section('Where it fits best', bullets(brand.best_for)) : null,

      brand?.objections.length ? section('When the client says ...',
        h('div', { class: 'card pad stack' }, brand.objections.map((o) => h('div', { class: 'objection' },
          h('p', { class: 'objection-if' }, `"${o.if}"`),
          h('p', { class: 'objection-then' }, o.then))))) : null,
      brand?.watch_out.length ? section('Be honest about', bullets(brand.watch_out)) : null,
      brand?.competitors.length ? section('Competitors in the market',
        h('div', { class: 'card pad stack' }, brand.competitors.map((c) => h('div', null, h('strong', null, c.name), c.note ? h('p', null, c.note) : null)))) : null,

      productList,
      ourRivals,

      written ? h('p', { class: 'muted small' }, 'Written by the office from public information. If something is wrong, ask your manager to correct it.')
        : h('p', { class: 'muted' }, 'The manager has not written about this brand yet. What you see here comes from the product guide.'),
    ].filter(Boolean));
  };

  const stop = store.subscribe(draw);
  const page = openPage({ title: 'Brand', body, onClose: stop });
  draw();
  return page;
}
