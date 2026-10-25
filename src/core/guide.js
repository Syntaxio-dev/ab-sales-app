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
