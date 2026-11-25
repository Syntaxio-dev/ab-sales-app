// Prospecting (v1.19): companies that do NOT work with us yet, found online or on the road, kept for cold calling and sorted by territory.
// One pool for the whole team, so two reps never call the same company and every rep can target an area. Pure functions: no screen, no storage.
import * as rules from './rules.js';
import { normalizePhone } from './phone.js';

export const MAX_PEOPLE = 10; // people saved at one prospect
export const MAX_REMARK = 300;
export const MAX_ADDRESS = 200;
export const MAX_AREAS = 20; // territories one rep keeps in "My territories"
// Quick picks under the territory box (the box takes any other place). Only a convenience: the team's own territories come first.
export const SUGGESTED_TERRITORIES = ['Sitapura', 'Sanganer', 'Jhotwara', 'Bagru', 'Kukas', 'Chomu', 'Dausa', 'Behror', 'Bhiwadi', 'Neemrana', 'Phulera', 'Kishangarh'];
const TWO_YEARS = 2 * 365 * 86_400_000;

// Where the rep found the company. Only a label for the manager's insight; nothing is read from these places by the app.
export const SOURCES = [
  { value: 'google', label: 'Google' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'indiamart', label: 'IndiaMART' },
  { value: 'directory', label: 'Directory or website' },
  { value: 'visit', label: 'Seen while visiting' },
  { value: 'reference', label: 'Reference' },
  { value: 'other', label: 'Other' },
];
export const isSource = (v) => SOURCES.some((s) => s.value === v);
export const sourceLabel = (v) => SOURCES.find((s) => s.value === v)?.label ?? '';

// What happened on a call. The newest one is the prospect's status. `open`: worth calling again.
export const OUTCOMES = [
  { value: 'no_answer', label: 'No answer', open: true },
  { value: 'call_back', label: 'Call back later', open: true },
  { value: 'interested', label: 'Interested', open: true },
  { value: 'meeting_fixed', label: 'Meeting fixed', open: true },
  { value: 'not_interested', label: 'Not interested', open: false },
  { value: 'wrong_number', label: 'Wrong number', open: false },
  { value: 'do_not_call', label: 'Do not call', open: false },
  { value: 'converted', label: 'Became a client', open: false },
];
export const isOutcome = (v) => OUTCOMES.some((o) => o.value === v);
export const outcomeLabel = (v) => OUTCOMES.find((o) => o.value === v)?.label ?? 'Not called yet';

// ---- territory ---------------------------------------------------------------------------------------------------------------

// "Bagru", "bagru " and "BAGRU" are one territory: compared without case, spaces and punctuation.
export const territoryKey = (name) => String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// A territory is written like a place (letters, spaces and . , ' -), one spelling per territory.
export const territoryProblem = (value) => rules.place(value, { label: 'Territory', requiredField: true });
export const cleanTerritory = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Every territory the team has prospects in, with how many: [{ name, count }], busiest first. When one territory was typed with two
 * spellings the first one found wins, so the list shows it once.
 */
export function territories(prospects) {
  const seen = new Map();
  for (const p of prospects) {
    const key = territoryKey(p.territory);
    if (!key) continue;
    const row = seen.get(key) ?? { name: cleanTerritory(p.territory), count: 0 };
    row.count++;
    seen.set(key, row);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// The spelling the team already uses for this territory (so "bagru" typed by a rep becomes "Bagru"), or the typed one.
export function canonicalTerritory(value, known) {
  const clean = cleanTerritory(value);
  const key = territoryKey(clean);
  return known.find((name) => territoryKey(name) === key) ?? clean;
}

// The rep's own list ("My territories"): clean, no repeats, at most MAX_AREAS. Anything that is not a valid territory is dropped.
export function cleanAreas(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = cleanTerritory(raw);
    if (!territoryProblem(name) && !out.some((n) => territoryKey(n) === territoryKey(name))) out.push(name);
  }
  return out.slice(0, MAX_AREAS);
}

export const inAreas = (prospect, areas) => areas.some((name) => territoryKey(name) === territoryKey(prospect.territory));

// ---- people at a prospect ---------------------------------------------------------------------------------------------------

/**
 * A LinkedIn address, kept as plain https://www.linkedin.com/in/name (no query, no tracking). Only linkedin.com is taken, so a link
 * that is shown on a screen can never lead somewhere else. -> the clean address, '' for empty, null when it is not a LinkedIn address.
 */
export function cleanLinkedin(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > 300 || /[\s<>"'\\]/.test(text)) return null;

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return null;

  const path = url.pathname.replace(/\/+$/, '');
  if (path.length < 2) return null; // the home page is not a profile
  const clean = `https://${host}${path}`;
  return clean.length <= 200 ? clean : null;
}

export const linkedinProblem = (value) => (cleanLinkedin(value) === null ? 'Enter a LinkedIn address, like linkedin.com/in/name or linkedin.com/company/name.' : null);

/** One person: everything optional except the name. -> the clean person, or throws nothing: use personProblems() first. */
export function cleanPerson(p) {
  return {
    name: String(p?.name ?? '').replace(/\s+/g, ' ').trim(),
    position: String(p?.position ?? '').replace(/\s+/g, ' ').trim(),
    phone: normalizePhone(String(p?.phone ?? '')) ?? '',
    email: String(p?.email ?? '').trim().toLowerCase(),
    linkedin: cleanLinkedin(p?.linkedin) ?? '',
  };
}

export function personProblem(p, label = 'Person') {
  return rules.firstError(
    rules.personName(p?.name, { label: `${label} name`, max: 150 }),
    String(p?.position ?? '').trim() ? rules.position(p.position) : null,
    rules.phone(p?.phone),
    rules.email(p?.email),
    linkedinProblem(p?.linkedin),
  );
}

// -> the first problem of the list, or null. Two people of one prospect cannot share a number.
export function peopleProblem(people) {
  if (!Array.isArray(people)) return 'The people are not a list.';
  if (people.length > MAX_PEOPLE) return `At most ${MAX_PEOPLE} people can be saved at one prospect.`;

  const numbers = new Set();
  for (const [i, p] of people.entries()) {
    const problem = personProblem(p, people.length > 1 ? `Person ${i + 1}:` : 'Person');
    if (problem) return problem;

    const phone = normalizePhone(String(p?.phone ?? ''));
    if (phone && numbers.has(phone)) return 'Two people here have the same number.';
    if (phone) numbers.add(phone);
  }
  return null;
}

// ---- status and views ---------------------------------------------------------------------------------------------------------

/** The newest call note decides. -> { outcome, label, note }; 'new' = nobody has called yet. */
export function statusOf(notes) {
  const last = [...notes].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return last ? { outcome: last.outcome, label: outcomeLabel(last.outcome), note: last } : { outcome: 'new', label: 'Not called yet', note: null };
}

// A prospect is still worth calling unless the last call closed it.
export const isOpenProspect = (status) => status.outcome === 'new' || OUTCOMES.find((o) => o.value === status.outcome)?.open === true;

export function noteProblem({ outcome, remark, next_followup_at: next }, now = Date.now()) {
  const at = next ? Date.parse(next) : null;
  return rules.firstError(
    isOutcome(outcome) ? null : 'Pick what happened on the call.',
    rules.optional(remark, { max: MAX_REMARK, label: 'Remark' }),
    at !== null && Number.isNaN(at) ? 'Pick a valid follow-up time.' : null,
    at !== null && at < now - 60_000 ? 'Pick a follow-up from now on.' : null,
    at !== null && at > now + TWO_YEARS ? 'A follow-up can be at most 2 years ahead.' : null,
  );
}

// The words typed in the search box against everything a rep would remember: company, territory, address, people, numbers.
export function matches(prospect, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;

  const digits = q.replace(/\D/g, '');
  const text = [prospect.name, prospect.territory, prospect.address, prospect.notes, ...prospect.people.flatMap((p) => [p.name, p.position, p.email, p.phone])].join(' ').toLowerCase();
  return text.includes(q) || (digits.length >= 3 && prospect.people.some((p) => (p.phone ?? '').replace(/\D/g, '').includes(digits)));
}

// "Called 3 days ago" style line for a list row.
export function lastCallLine(status, now = Date.now()) {
  if (!status.note) return 'Not called yet';
  const days = Math.floor((now - Date.parse(status.note.created_at)) / 86_400_000);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `${status.label} · ${when}`;
}
