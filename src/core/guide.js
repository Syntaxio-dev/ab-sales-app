// The product guide: finding a product, and the three budget ranges. The manager writes the guide on the website; the phone only reads it.

// What to suggest, by how much the client can spend.
export const TIERS = [
  { key: 'premium_brands', value: 'premium', label: 'Premium', hint: 'Big budget' },
  { key: 'economy_brands', value: 'economy', label: 'Economy', hint: 'Middle budget' },
  { key: 'lite_brands', value: 'lite', label: 'Lite', hint: 'Small budget' },
];

export const tierOf = (value) => TIERS.find((t) => t.value === value) ?? null;

// A guide kept on a phone before the "before the meeting" fields existed has none of them: they get empty defaults when it is read.
const PRODUCT_DEFAULTS = { client_types: [], pitch: '', key_notes: [], formula: '', do: [], avoid: [], match_rules: [] };
export const withGuideDefaults = (product) => ({ ...PRODUCT_DEFAULTS, ...product });

// Who the rep may be meeting today. The ids are the ones the office uses (a product is marked "usually bought by" these).
export const CLIENT_TYPES = [
  { id: 'pharma_qc', label: 'Pharma QC', icon: 'flask' },
  { id: 'hospital', label: 'Hospital & pathology', icon: 'pulse' },
  { id: 'university', label: 'University & research', icon: 'cap' },
  { id: 'food_dairy', label: 'Food & dairy', icon: 'utensils' },
  { id: 'industrial_qc', label: 'Industrial QC', icon: 'settings' },
  { id: 'water_environment', label: 'Water & environment', icon: 'drop' },
];
export const CLIENT_TYPE_IDS = CLIENT_TYPES.map((t) => t.id);
export const clientTypeOf = (id) => CLIENT_TYPES.find((t) => t.id === id) ?? null;

/** The products marked as usually bought by this kind of client, in the order of the sheet. */
export const productsForClientType = (products, id) => products.filter((p) => p.client_types.includes(id)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

/**
 * The manager marks the words to highlight with two stars: "spins fast so the **heavy parts settle**".
 * -> ['spins fast so the ', { hl: 'heavy parts settle' }]. Text only: the screen builds a span from it, never HTML.
 */
export function highlight(text) {
  const parts = [];
  String(text ?? '').split('**').forEach((piece, i) => {
    if (piece) parts.push(i % 2 === 1 ? { hl: piece } : piece);
  });
  return parts;
}

/** The first sentence of a text (at most "max" letters), for the one-liner under a product's name. */
export function firstSentence(text, max = 150) {
  const clean = String(text ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const end = clean.search(/[.!?](\s|$)/);
  const one = end > 0 ? clean.slice(0, end + 1) : clean;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/**
 * The cheat sheet of a product: the manager's key notes when he wrote them; otherwise a short version of what is in the guide
 * (the brands by budget, then the first questions to ask), so the sheet is never empty and never invented.
 * -> [{ text, label? }] at most 5 rows.
 */
export function cheatNotes(p) {
  if (p.key_notes.length) return p.key_notes.slice(0, 5).map((text) => ({ text }));

  const rows = TIERS.filter((t) => p[t.key].length).map((t) => ({ label: t.label, text: p[t.key].join(', ') }));
  for (const q of p.key_parameters.slice(0, Math.max(0, 5 - rows.length))) rows.push({ label: 'Ask', text: q });
  return rows.slice(0, 5);
}

/** The rep's own scripts that match the words typed (title, product, text). Newest first. */
export function searchScripts(scripts, query) {
  const wanted = words(query);
  if (!wanted.length) return scripts;

  return scripts.filter((s) => {
    const tokens = words(`${s.title} ${s.product_name} ${s.body}`);
    return wanted.every((w) => tokens.some((t) => t === w || t.startsWith(w)));
  });
}

// "Ika, Cole-Parmer" -> ["ika", "cole", "parmer"]: lower case, letters and digits only, so "Cole Parmer" finds "Cole-Parmer".
const words = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// The places a word can be found in, best first. `label` is what the rep is told ("Premium brand", "Problem in the first year" ...).
const places = (p) => [
  { label: 'Name', weight: 10, text: p.name },
  { label: 'Family', weight: 4, text: p.group },
  { label: 'Premium brand', weight: 8, text: p.premium_brands.join(' ') },
  { label: 'Economy brand', weight: 8, text: p.economy_brands.join(' ') },
  { label: 'Lite brand', weight: 8, text: p.lite_brands.join(' ') },
  { label: 'Top brand', weight: 6, text: p.top_brands.map((b) => `${b.name} ${b.note}`).join(' ') },
  { label: 'Type', weight: 5, text: p.variants.map((v) => `${v.name} ${v.text}`).join(' ') },
  { label: 'About', weight: 3, text: `${p.summary} ${p.industries}` },
  { label: 'Pitch', weight: 3, text: `${p.pitch} ${p.key_notes.join(' ')}` },
  { label: 'Question to ask', weight: 2, text: p.key_parameters.join(' ') },
  { label: 'Problem in the first year', weight: 2, text: p.short_term_problems.join(' ') },
  { label: 'Problem after a year', weight: 2, text: p.long_term_problems.join(' ') },
];

/**
 * Search the whole guide at once: every word typed must be found somewhere in the product (name, brands, types, questions, problems ...).
 * A word that starts a word counts ("balan" finds "balance"). Returns [{ product, score, found }] best first; `found` says where the
 * best match was, unless it is the name. With no words everything comes back in the sheet's order.
 */
export function searchProducts(products, query, { group = '', tier = '' } = {}) {
  const wanted = words(query);
  const tierKey = tierOf(tier)?.key ?? null;
  const out = [];

  for (const product of products) {
    if (group && product.group !== group) continue;
    if (tierKey && !product[tierKey].length) continue;

    if (!wanted.length) {
      out.push({ product, score: 0, found: null });
      continue;
    }

    const spots = places(product).map((s) => ({ ...s, tokens: words(s.text) }));
    let score = 0;
    let best = null;
    let all = true;

    for (const word of wanted) {
      let top = null;
      for (const spot of spots) {
        const hit = spot.tokens.includes(word) ? 1 : spot.tokens.some((t) => t.startsWith(word)) ? 0.6 : 0;
        if (hit && (!top || spot.weight * hit > top.value)) top = { value: spot.weight * hit, spot };
      }
      if (!top) {
        all = false;
        break;
      }
      score += top.value;
      if (!best || top.value > best.value) best = top;
    }

    if (all) out.push({ product, score, found: best.spot.label === 'Name' ? null : best.spot.label });
  }

  return out.sort((a, b) => b.score - a.score || a.product.sort - b.product.sort || a.product.name.localeCompare(b.product.name));
}

/** The families in the order of the sheet: [{ name, count }]. */
export function groupsOf(products) {
  const map = new Map();
  for (const p of [...products].sort((a, b) => a.sort - b.sort)) {
    if (!p.group) continue;
    map.set(p.group, (map.get(p.group) ?? 0) + 1);
  }
  return [...map].map(([name, count]) => ({ name, count }));
}

/** "Sartorius, Mettler" or "No brand listed" */
export const brandLine = (list) => (list.length ? list.join(', ') : 'No brand listed');

// ---- the brand guide (v1.18) -------------------------------------------------------------------------------------------------
// The manager writes what a brand is best at; WHICH of our products carry it, and in which budget tier, comes from the product
// guide, so nothing is typed twice and the two never disagree.

const BRAND_DEFAULTS = { origin: '', channel: '', about: '', known_for: [], known_lines: [], best_for: [], pitch: [], objections: [], watch_out: [], competitors: [], sort: 0 };
export const withBrandDefaults = (brand) => ({ ...BRAND_DEFAULTS, ...brand });

// "Cole-Parmer", "cole parmer" and "Cole Parmer " are one brand.
export const brandKey = (name) => words(name).join(' ');

/** The brand of the brand guide with this name, or null. */
export const brandNamed = (brands, name) => {
  const key = brandKey(name);
  return (key && brands.find((b) => brandKey(b.name) === key)) || null;
};

/** The products that carry this brand: [{ product, tier }] (tier = TIERS entry), in the order of the sheet. */
export function brandProducts(products, name) {
  const key = brandKey(name);
  const out = [];
  if (!key) return out;
  for (const product of [...products].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))) {
    const tier = TIERS.find((t) => product[t.key].some((b) => brandKey(b) === key));
    if (tier) out.push({ product, tier });
  }
  return out;
}

/** How many of our products carry the brand in each tier: { premium: 3, economy: 1, lite: 0 }. */
export function brandTierCounts(products, name) {
  const counts = { premium: 0, economy: 0, lite: 0 };
  for (const { tier } of brandProducts(products, name)) counts[tier.value] += 1;
  return counts;
}

/** "Premium" / "Premium and economy" / "" : the tiers the brand sits in, for a one-line label. */
export function brandTierLine(products, name) {
  const counts = brandTierCounts(products, name);
  const used = TIERS.filter((t) => counts[t.value]).map((t) => t.label);
  if (!used.length) return '';
  return used.length === 1 ? used[0] : `${used.slice(0, -1).join(', ')} and ${used.at(-1).toLowerCase()}`;
}

/**
 * The other brands of OUR guide that sit in the same products (any tier): [{ name, shared, tierHint }] most shared first, at most `max`.
 * `tierHint` = 'premium' | 'economy' | 'lite': where that brand usually sits in those shared products (so the rep sees "the premium
 * alternative" or "the cheaper option").
 */
export function guideRivals(products, name, max = 8) {
  const key = brandKey(name);
  const map = new Map();
  for (const { product } of brandProducts(products, name)) {
    for (const tier of TIERS) {
      for (const other of product[tier.key]) {
        const k = brandKey(other);
        if (!k || k === key) continue;
        const row = map.get(k) ?? { name: other, shared: 0, tiers: { premium: 0, economy: 0, lite: 0 }, products: new Set() };
        if (!row.products.has(product.id)) {
          row.products.add(product.id);
          row.shared += 1;
        }
        row.tiers[tier.value] += 1;
        map.set(k, row);
      }
    }
  }
  return [...map.values()]
    .map((r) => ({ name: r.name, shared: r.shared, tierHint: Object.entries(r.tiers).sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name))
    .slice(0, max);
}

/** Every brand the rep can open: the brand guide's brands plus any brand that is only named in the product lists. Most products first. */
export function allBrands(brands, products) {
  const map = new Map();
  for (const b of brands) map.set(brandKey(b.name), { name: b.name, brand: b, count: 0 });
  for (const p of products) {
    const seen = new Set();
    for (const t of TIERS) {
      for (const n of p[t.key]) {
        const k = brandKey(n);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        const row = map.get(k) ?? { name: n, brand: null, count: 0 };
        row.count += 1;
        map.set(k, row);
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The brands whose name or notes match every word typed (name first). With no words: none. */
export function searchBrands(brands, query) {
  const wanted = words(query);
  if (!wanted.length) return [];
  const out = [];
  for (const brand of brands) {
    const nameTokens = words(brand.name);
    const rest = words([brand.origin, brand.about, ...brand.known_for, ...brand.known_lines, ...brand.best_for].join(' '));
    let score = 0;
    let all = true;
    for (const w of wanted) {
      if (nameTokens.some((t) => t === w || t.startsWith(w))) score += 10;
      else if (rest.some((t) => t === w || t.startsWith(w))) score += 2;
      else {
        all = false;
        break;
      }
    }
    if (all) out.push({ brand, score });
  }
  return out.sort((a, b) => b.score - a.score || a.brand.name.localeCompare(b.brand.name)).map((r) => r.brand);
}
