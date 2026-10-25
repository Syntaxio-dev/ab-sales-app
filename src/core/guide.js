// The product guide: finding a product, and the three budget ranges. The manager writes the guide on the website; the phone only reads it.

// What to suggest, by how much the client can spend.
export const TIERS = [
  { key: 'premium_brands', value: 'premium', label: 'Premium', hint: 'Big budget' },
  { key: 'economy_brands', value: 'economy', label: 'Economy', hint: 'Middle budget' },
  { key: 'lite_brands', value: 'lite', label: 'Lite', hint: 'Small budget' },
];

export const tierOf = (value) => TIERS.find((t) => t.value === value) ?? null;

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
