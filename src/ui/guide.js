import { CLIENT_TYPES, TIERS, brandLine, cheatNotes, clientTypeOf, firstSentence, groupsOf, highlight, productsForClientType, searchProducts, searchScripts } from '../core/guide.js';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { formatDay } from './format.js';
import { businessInput } from './inputs.js';
import { confirmDialog, dialog, field, openBottomSheet, openPage, toast, validate } from './kit.js';
import { empty, fill, head } from './parts.js';

// The product guide. The manager writes it on the website and it is kept on every phone (it works offline); the rep only reads it,
// asks for notes, and writes their OWN scripts (a pitch in their own words, private to them, kept at the office as a copy).
//
// The Guide tab is "Who are you meeting today?": a search box, six kinds of client, the products that kind usually buys, the rep's
// scripts, and a way to browse everything. A product opens as a brief: the 20-second pitch, the rep's script, what to suggest by
// budget, a checklist of questions, do / avoid, and a cheat sheet that slides up.

const SHOWN = 60; // rows of a search that are drawn at once
const RECOMMENDED = 8;

// What the rep typed / chose stays while the screen is redrawn (a sync finishing) and while another tab is looked at.
const view = { query: '', type: null };

export function resetGuideView() {
  view.query = '';
  view.type = null;
}

const paragraphs = (text) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => h('p', null, line));
const bullets = (list) => h('ul', { class: 'bullets' }, list.map((line) => h('li', null, line)));

// A text with **marked words**: the marked words become highlighted spans (text nodes only, never HTML).
const marked = (text) => highlight(text).map((part) => (typeof part === 'string' ? part : h('span', { class: 'hl' }, part.hl)));

const learnedMark = () => h('span', { class: 'learned-mark', role: 'img', 'aria-label': 'Learned' }, icon('check', 14));

// the first brands of the first budget range that has any: "Premium: Sartorius, Mettler"
const brandsHint = (p) => {
  const tier = TIERS.find((t) => p[t.key].length);
  return tier ? `${tier.label}: ${brandLine(p[tier.key].slice(0, 3))}` : 'No brands listed yet';
};

function productRow(app, product, found = null) {
  const learned = app.store.guideProgress.learned[product.id] === true;

  return h('button', { class: 'item guide-row', type: 'button', onclick: () => openProduct(app, product.id) },
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, product.name),
      h('span', { class: 'sub' }, found ? `Found in: ${found}` : brandsHint(product))),
    learned ? learnedMark() : null,
    icon('chevron', 18));
}

function scriptRow(app, script) {
  return h('button', { class: 'item guide-row', type: 'button', onclick: () => openScript(app, script.id) },
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, script.title || script.product_name),
      h('span', { class: 'sub' }, script.title ? `${script.product_name} · ${script.body}` : script.body)),
    icon('chevron', 18));
}

// ---- the Guide tab ----

export function renderGuide(container, app, ctx) {
  const store = app.store;
  const products = store.guideProducts;
  const body = h('div', { class: 'guide-body' });

  const chosen = () => view.type ?? store.guideProgress.client_type ?? CLIENT_TYPES[0].id;

  const homeView = () => {
    const type = clientTypeOf(chosen());
    const picks = productsForClientType(products, type.id);
    const scripts = store.scripts;

    const tiles = h('div', { class: 'type-grid', role: 'group', 'aria-label': 'Kind of client' }, CLIENT_TYPES.map((t) => h('button', {
      class: 'type-tile', type: 'button', 'aria-pressed': String(t.id === type.id),
      onclick() {
        view.type = t.id;
        draw();
        void store.setGuideClientType(t.id);
      },
    }, icon(t.icon, 22), h('span', null, t.label))));

    const recommended = h('section', { class: 'guide-section' },
      h('p', { class: 'eyebrow' }, `${type.label} usually buy`),
      picks.length
        ? h('div', { class: 'list' }, picks.slice(0, RECOMMENDED).map((p) => productRow(app, p)))
        : h('div', { class: 'card pad muted' }, 'No product is marked for this kind of client yet. Use the search above, or browse everything below.'),
      picks.length > RECOMMENDED ? h('p', { class: 'muted small' }, `${picks.length - RECOMMENDED} more in "Browse all products".`) : null);

    const mine = h('section', { class: 'guide-section' },
      h('div', { class: 'section-head' },
        h('p', { class: 'eyebrow' }, `My scripts${scripts.length ? ` (${scripts.length})` : ''}`),
        h('button', { class: 'link', type: 'button', onclick: () => openScriptEditor(app) }, '+ New script')),
      scripts.length
        ? h('div', { class: 'list' }, scripts.slice(0, 3).map((s) => scriptRow(app, s)))
        : h('div', { class: 'card pad muted' }, 'Write your own pitch for a product, in your own words, and keep it here for the day you need it.'),
      scripts.length > 3 ? h('button', { class: 'link left', type: 'button', onclick: () => openScriptsPage(app) }, `See all ${scripts.length} scripts`) : null);

    const browse = h('button', { class: 'browse-row', type: 'button', onclick: () => openBrowse(app) },
      h('span', null, `Browse all ${products.length} products`), icon('chevron', 18));

    return [
      h('section', { class: 'guide-section' }, tiles),
      recommended,
      mine,
      browse,
      h('button', { class: 'btn block', type: 'button', onclick: () => askNote(app, null) }, icon('edit', 18), 'Ask the manager to add something'),
    ];
  };

  const resultsView = (q) => {
    const found = searchProducts(products, q);
    const scripts = searchScripts(store.scripts, q);

    return [
      h('p', { class: 'muted small' }, `${found.length} of ${products.length} products${scripts.length ? ` · ${scripts.length} of your scripts` : ''}`),
      scripts.length ? h('section', { class: 'guide-section' }, h('p', { class: 'eyebrow' }, 'My scripts'), h('div', { class: 'list' }, scripts.slice(0, 10).map((s) => scriptRow(app, s)))) : null,
      found.length
        ? h('section', { class: 'guide-section' }, h('p', { class: 'eyebrow' }, 'Products'), h('div', { class: 'list' }, found.slice(0, SHOWN).map(({ product, found: where }) => productRow(app, product, where))))
        : (scripts.length ? null : empty('search', 'Nothing found', 'Try one word, a brand name, or a problem.')),
    ];
  };

  const draw = () => {
    if (!products.length) {
      body.replaceChildren(empty('book', 'The guide is not on this phone yet', app.sync?.status.connected ? 'It arrives with the next sync. Open Settings > Office and press Sync now.' : 'Sign in to the office (Settings > Office) and it comes to this phone.'));
      return;
    }

    const q = view.query.trim();
    body.replaceChildren(...(q ? resultsView(q) : homeView()).filter(Boolean));
  };

  // the search sits right under the title, big and clear, and works on products, brands, problems and the rep's own scripts
  const input = h('input', {
    class: 'input', type: 'search', placeholder: 'Search products, brands, scripts', autocomplete: 'off', enterKeyHint: 'search', 'aria-label': 'Search the product guide', value: view.query,
  });
  input.addEventListener('input', () => {
    view.query = input.value;
    draw();
  });

  fill(container,
    head({ eyebrow: 'Before the meeting', title: 'Who are you meeting today?' }),
    h('div', { class: 'guide-search' }, icon('search', 20), input),
    body);
  ctx.fab(null);
  draw();
}

// ---- all products (grouped by family, with the budget and family filters) ----

function openBrowse(app) {
  const store = app.store;
  const state = { query: '', group: '', tier: '' };
  const list = h('div', { class: 'guide-body' });
  const count = h('p', { class: 'muted small' });
  const tierRow = h('div', { class: 'filters', role: 'group', 'aria-label': 'Budget' });
  const groupRow = h('div', { class: 'filters', role: 'group', 'aria-label': 'Product family' });
  const chip = (label, active, onclick) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(active), onclick }, label);

  const draw = () => {
    const products = store.guideProducts;

    tierRow.replaceChildren(
      chip('Any budget', state.tier === '', () => { state.tier = ''; draw(); }),
      ...TIERS.map((t) => chip(t.label, state.tier === t.value, () => { state.tier = state.tier === t.value ? '' : t.value; draw(); })));
    groupRow.replaceChildren(
      chip('All families', state.group === '', () => { state.group = ''; draw(); }),
      ...groupsOf(products).map((g) => chip(g.name, state.group === g.name, () => { state.group = state.group === g.name ? '' : g.name; draw(); })));

    const found = searchProducts(products, state.query, { group: state.group, tier: state.tier });
    count.textContent = `${found.length} of ${products.length} products`;

    // with no words typed the products are shown under their family; with words, best match first
    if (state.query.trim()) {
      list.replaceChildren(...(found.length
        ? [h('div', { class: 'list' }, found.slice(0, SHOWN).map(({ product, found: where }) => productRow(app, product, where)))]
        : [empty('search', 'Nothing found', 'Try one word, a brand name, or clear the filters.')]));
      return;
    }

    const byGroup = new Map();
    for (const { product } of found) byGroup.set(product.group || 'Other', [...(byGroup.get(product.group || 'Other') ?? []), product]);

    list.replaceChildren(...(found.length
      ? [...byGroup].map(([name, items]) => h('section', { class: 'guide-section' }, h('p', { class: 'eyebrow' }, `${name} (${items.length})`), h('div', { class: 'list' }, items.map((p) => productRow(app, p)))))
      : [empty('search', 'Nothing found', 'Clear the filters to see everything.')]));
  };

  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search all products', autocomplete: 'off', enterKeyHint: 'search', 'aria-label': 'Search all products' });
  input.addEventListener('input', () => {
    state.query = input.value;
    draw();
  });

  const stop = store.subscribe(draw);
  openPage({
    title: 'All products',
    body: h('div', { class: 'stack guide-page' }, h('div', { class: 'guide-search' }, icon('search', 20), input), tierRow, groupRow, count, list),
    onClose: stop,
  });
  draw();
}

// ---- one product: the brief ----

function fold(title, content, open = false) {
  return h('details', { class: 'fold', open },
    h('summary', null, h('span', null, title), icon('chevron', 18)),
    h('div', { class: 'fold-body' }, content));
}

export function openProduct(app, id) {
  const store = app.store;
  const body = h('div', { class: 'stack guide-page' });
  const ask = h('button', { class: 'btn block', type: 'button', onclick: () => askNote(app, store.productById(id)) }, icon('edit', 18), 'Ask for a note or a correction');
  const learnedButton = h('button', { class: 'btn block', type: 'button' });
  let page = null;

  const requestsOf = () => store.notes.filter((n) => n.product_id === id).slice(0, 5);
  const stateOf = (n) => (n.sync_error ? `Not accepted: ${n.sync_error}` : n.synced ? 'Sent to your manager' : 'Waiting to be sent');

  learnedButton.addEventListener('click', () => {
    void store.setGuideLearned(id, store.guideProgress.learned[id] !== true);
  });

  const draw = () => {
    const p = store.productById(id);
    if (!p) { // the manager removed it meanwhile
      page?.close();
      return;
    }

    const progress = store.guideProgress;
    const ticked = new Set(progress.ticks[id] ?? []);
    const learned = progress.learned[id] === true;
    const mine = store.scriptsOf(id);

    learnedButton.className = `btn block${learned ? '' : ' primary'}`;
    learnedButton.replaceChildren(...(learned ? [icon('check', 18), 'Learned'] : ['Mark as learned']));
    learnedButton.setAttribute('aria-pressed', String(learned));

    const oneLine = firstSentence(p.summary);

    const questions = p.key_parameters.length ? h('section', { class: 'guide-section' },
      h('div', { class: 'section-head' },
        h('h3', { class: 'guide-h' }, 'Ask the client'),
        h('span', { class: 'counter' }, `${[...ticked].filter((n) => n < p.key_parameters.length).length} / ${p.key_parameters.length}`)),
      h('div', { class: 'list' }, p.key_parameters.map((q, n) => h('button', {
        class: 'item check-row', type: 'button', role: 'checkbox', 'aria-checked': String(ticked.has(n)),
        onclick() { void store.tickGuideQuestion(id, n); },
      }, h('span', { class: 'box' }, ticked.has(n) ? icon('check', 16) : null), h('span', { class: 'grow' }, h('span', { class: 'title' }, q))))),
      ticked.size ? h('button', { class: 'link left', type: 'button', onclick: () => { void store.resetGuideTicks(id); } }, 'Reset') : null) : null;

    const tiers = h('section', { class: 'guide-section' },
      h('h3', { class: 'guide-h' }, 'What to suggest, by budget'),
      h('div', { class: 'card pad stack' }, TIERS.map((t) => h('div', { class: 'tier' },
        h('div', { class: 'tier-head' }, h('span', { class: `chip ${t.value}` }, t.label), h('span', { class: 'muted small' }, t.hint)),
        p[t.key].length
          ? h('div', { class: 'people' }, p[t.key].map((brand) => h('span', { class: 'chip' }, brand)))
          : h('p', { class: 'muted small' }, 'No brand listed for this range.')))));

    const scripts = h('section', { class: 'guide-section' },
      h('div', { class: 'section-head' },
        h('h3', { class: 'guide-h' }, 'My script'),
        h('button', { class: 'link', type: 'button', onclick: () => openScriptEditor(app, { product: p }) }, mine.length ? '+ Another' : '+ Write mine')),
      mine.length
        ? h('div', { class: 'list' }, mine.map((s) => scriptRow(app, s)))
        : h('div', { class: 'card pad muted' }, 'Write what you will say about this product, in your own words. Only you can read it.'));

    const doAvoid = p.do.length || p.avoid.length ? h('section', { class: 'guide-section do-avoid' },
      p.do.length ? h('div', { class: 'da do' }, h('p', { class: 'da-label' }, 'Do'), h('ul', null, p.do.map((t) => h('li', null, marked(t))))) : null,
      p.avoid.length ? h('div', { class: 'da avoid' }, h('p', { class: 'da-label' }, 'Avoid'), h('ul', null, p.avoid.map((t) => h('li', null, marked(t))))) : null) : null;

    const match = p.match_rules.length ? h('section', { class: 'guide-section' },
      h('h3', { class: 'guide-h' }, 'Match the model'),
      h('div', { class: 'card pad stack' }, p.match_rules.map((m) => h('div', { class: 'match-row' },
        h('span', { class: 'if' }, marked(m.if)), icon('chevron', 16), h('span', { class: 'then' }, m.then))))) : null;

    const asked = requestsOf();

    body.replaceChildren(...[
      h('div', { class: 'brief-actions' },
        h('button', { class: 'btn primary cheat-btn', type: 'button', onclick: () => openCheatSheet(app, id) }, icon('bolt', 18), 'Cheat sheet')),

      h('div', { class: 'brief-title' },
        h('p', { class: 'eyebrow' }, `Product brief${p.group ? ` · ${p.group}` : ''}`),
        h('h2', null, p.name),
        oneLine ? h('p', { class: 'lead' }, marked(oneLine)) : null),

      p.pitch ? h('section', { class: 'pitch-card' }, h('p', { class: 'eyebrow' }, 'Your 20-second pitch'), h('p', { class: 'pitch' }, marked(p.pitch))) : null,
      scripts,
      tiers,
      questions,
      doAvoid,
      match,

      p.summary || p.industries ? fold('About this product', h('div', { class: 'stack' }, ...paragraphs(p.summary), p.industries ? h('p', null, `Industries: ${p.industries}`) : null)) : null,
      p.variants.length ? fold(`Types in the market (${p.variants.length})`, h('div', { class: 'stack' }, p.variants.map((v) => h('div', null, v.name ? h('strong', null, v.name) : null, h('p', null, v.text))))) : null,
      p.short_term_problems.length ? fold('Problems in the first 12 months', bullets(p.short_term_problems)) : null,
      p.long_term_problems.length ? fold('Problems after a year', bullets(p.long_term_problems)) : null,
      p.top_brands.length ? fold('Top brands and why', h('div', { class: 'stack' }, p.top_brands.map((b) => h('div', null, h('strong', null, b.name), b.note ? h('p', null, b.note) : null)))) : null,
      !p.summary && !p.variants.length && !p.key_parameters.length && !p.short_term_problems.length ? h('p', { class: 'muted' }, 'The manager has not written the details of this product yet. You can ask for them below.') : null,

      asked.length ? h('section', { class: 'guide-section' },
        h('p', { class: 'eyebrow' }, 'Your requests for this product'),
        h('div', { class: 'list' }, asked.map((n) => h('div', { class: 'item', style: { minHeight: '56px' } }, h('span', { class: 'grow' }, h('span', { class: 'title' }, n.body), h('span', { class: 'sub' }, stateOf(n))))))) : null,

      ask,
    ].filter(Boolean));
  };

  const stop = store.subscribe(draw);
  page = openPage({ title: 'Product', body, footer: learnedButton, onClose: stop });
  draw();
  return page;
}

// ---- the cheat sheet: a panel that slides up over the brief ----

function openCheatSheet(app, id) {
  const p = app.store.productById(id);
  if (!p) return null;

  const rows = cheatNotes(p).map((row, n) => h('li', { class: 'cheat-row' },
    h('span', { class: 'num' }, String(n + 1)),
    h('span', { class: 'text' }, row.label ? h('span', { class: 'cheat-label' }, `${row.label} `) : null, marked(row.text))));

  return openBottomSheet({
    label: `Cheat sheet: ${p.name}`,
    head: h('div', null, h('p', { class: 'eyebrow' }, 'Cheat sheet'), h('h2', null, p.name)),
    body: h('div', { class: 'stack' },
      rows.length ? h('ol', { class: 'cheat-list' }, rows) : h('p', { class: 'muted' }, 'The manager has not written the notes of this product yet.'),
      p.formula ? h('div', { class: 'formula' }, p.formula) : null),
  });
}

// ---- my scripts: the rep's own pitch for a product ----

// All my scripts, with a search (the day a rep needs one, this is where they come).
function openScriptsPage(app) {
  const store = app.store;
  const list = h('div', { class: 'list' });
  let query = '';

  const draw = () => {
    const found = searchScripts(store.scripts, query);
    list.replaceChildren(...(found.length
      ? found.map((s) => scriptRow(app, s))
      : [empty('edit', store.scripts.length ? 'Nothing found' : 'No scripts yet', store.scripts.length ? 'Try another word.' : 'Write your own pitch for a product and it is kept here.')]));
  };

  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search my scripts', autocomplete: 'off', enterKeyHint: 'search', 'aria-label': 'Search my scripts' });
  input.addEventListener('input', () => {
    query = input.value;
    draw();
  });

  const stop = store.subscribe(draw);
  openPage({
    title: 'My scripts',
    body: h('div', { class: 'stack guide-page' }, h('div', { class: 'guide-search' }, icon('search', 20), input), list),
    footer: h('button', { class: 'btn primary block', type: 'button', onclick: () => openScriptEditor(app) }, icon('plus', 18), 'New script'),
    onClose: stop,
  });
  draw();
}

// Reading view: big, calm text, to look at before or during a visit.
function openScript(app, id) {
  const store = app.store;
  const body = h('div', { class: 'stack guide-page' });
  let page = null;

  const draw = () => {
    const s = store.scriptById(id);
    if (!s) { // deleted (here or on another phone)
      page?.close();
      return;
    }

    const product = s.product_id ? store.productById(s.product_id) : null;
    body.replaceChildren(...[
      h('div', { class: 'brief-title' },
        h('p', { class: 'eyebrow' }, 'My script'),
        h('h2', null, s.title || s.product_name),
        s.title ? h('p', { class: 'lead' }, s.product_name) : null),
      h('div', { class: 'card pad' }, h('p', { class: 'script-text' }, s.body)),
      h('p', { class: 'muted small' }, `Written ${formatDay(new Date(s.created_at))}${s.updated_at !== s.created_at ? `, changed ${formatDay(new Date(s.updated_at))}` : ''}. Only you can read it.`),
      product ? h('button', { class: 'btn block', type: 'button', onclick: () => openProduct(app, product.id) }, icon('book', 18), 'Open the product brief') : null,
      s.sync_error ? h('p', { class: 'err' }, `The office did not accept this script: ${s.sync_error}`) : null,
    ].filter(Boolean));
  };

  const stop = store.subscribe(draw);
  page = openPage({
    title: 'Script',
    body,
    footer: h('button', { class: 'btn primary block', type: 'button', onclick: () => openScriptEditor(app, { script: store.scriptById(id) }) }, icon('edit', 18), 'Edit script'),
    onClose: stop,
  });
  draw();
}

// New or changed script. From a product page the product is fixed; from the Guide tab the rep picks one (or types another name).
function openScriptEditor(app, { script = null, product = null } = {}) {
  const store = app.store;
  const OTHER = '__other__';
  const fixed = product ?? (script?.product_id ? store.productById(script.product_id) : null);

  const products = [...store.guideProducts].sort((a, b) => a.name.localeCompare(b.name));
  const which = fixed ? null : field('Product', h('select', { class: 'input' },
    products.length && !script ? h('option', { value: '' }, 'Choose a product') : null,
    ...products.map((p) => h('option', { value: p.id }, p.name)),
    h('option', { value: OTHER }, 'Something else (type the name)')));
  const typed = fixed ? null : field('Product name', businessInput({ value: script && !script.product_id ? script.product_name : '', placeholder: 'For example Weighing balance' }));
  const title = field('Title (optional)', h('input', { class: 'input', type: 'text', maxLength: 120, autocomplete: 'off', placeholder: 'For example For pharma buyers', value: script?.title ?? '' }));
  const text = field('My script', h('textarea', { class: 'input script-input', rows: 10, maxLength: 3000, placeholder: 'What I will say about this product ...', value: script?.body ?? '' }),
    'Write it the way you speak. Only you can read it.');

  if (which) {
    which.input.value = script ? (script.product_id && store.productById(script.product_id) ? script.product_id : OTHER) : (products.length ? '' : OTHER);
    const showTyped = () => { typed.el.hidden = which.input.value !== OTHER; };
    which.input.addEventListener('change', showTyped);
    showTyped();
  }

  const save = h('button', { class: 'btn primary block', type: 'button' }, 'Save script');
  save.addEventListener('click', async () => {
    const choice = which ? which.input.value : fixed.id;
    const isOther = choice === OTHER;

    const ok = validate([
      ...(which ? [[which, choice === '' ? 'Choose a product, or pick "Something else".' : null]] : []),
      ...(typed ? [[typed, isOther ? rules.businessName(typed.input.value, { label: 'Product name' }) : null]] : []),
      [title, rules.optional(title.input.value, { max: 120, label: 'Title' })],
      [text, rules.required(text.input.value, { min: 3, max: 3000, label: 'Your script' })],
    ]);
    if (!ok) return;

    save.disabled = true;
    try {
      const saved = await store.saveScript({
        id: script?.id,
        product_id: isOther ? null : choice,
        product_name: isOther ? typed.input.value : '',
        title: title.input.value,
        body: text.input.value,
      });
      toast('Script saved.');
      page.close();
      if (!script) openScript(app, saved.id);
    } catch (error) {
      toast(error instanceof ValidationError ? error.message : 'Could not save the script.');
      save.disabled = false;
    }
  });

  const page = openPage({
    title: script ? 'Edit script' : 'New script',
    body: h('div', { class: 'stack guide-page' },
      fixed ? h('p', { class: 'muted small' }, `For ${fixed.name}`) : null,
      which?.el, typed?.el, title.el, text.el,
      script ? h('button', {
        class: 'btn danger block',
        type: 'button',
        async onclick() {
          if (await confirmDialog({ title: 'Delete this script?', text: 'It is removed from this phone and from the office copy. This cannot be undone.' })) {
            await store.deleteScript(script.id);
            page.close();
          }
        },
      }, icon('trash', 18), 'Delete script') : null),
    footer: save,
  });
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
