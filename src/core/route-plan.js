// "Plan a route" (v1.19): the rep picks several companies for one day at once, from the clients AND the prospects, and gets one route with a
// planned meeting for each. Pure functions: no screen, no storage.
import { searchClients } from './enquiry.js';
import { MAX_STOPS, ROUTE_MINUTES, dayKey, routeTitleFor } from './meeting.js';
import { matches as prospectMatches } from './prospect.js';

export { MAX_STOPS };

const MINUTE = 60_000;
const lower = (text) => String(text ?? '').trim().toLowerCase();

// One company of the route, from either list. `key` tells two stops apart.
export const stopFromClient = (c) => ({ key: `client:${c.id}`, kind: 'client', id: c.id, name: c.name, place: c.city || '' });
export const stopFromProspect = (p) => ({ key: `prospect:${p.id}`, kind: 'prospect', id: p.id, name: p.name, place: p.territory || '' });

/**
 * What the picker offers. With no words typed: the clients the office gave to this rep (all clients when none was given) and the open
 * prospects in the rep's territories. With words: every client and prospect that fits (name, place, company, a person, a number).
 * -> { clients, prospects } (each at most `max`).
 *
 * `status(prospectId)` -> { outcome } (the prospect's newest call); a closed prospect (not interested, wrong number, do not call, became a
 * client) is not offered unless the rep searches for it, and a "do not call" one is never offered.
 */
export function searchStops({ clients, prospects, status, me = null, areas = [] }, text, { max = 8 } = {}) {
  const q = lower(text);
  const closed = (p) => ['not_interested', 'wrong_number', 'do_not_call', 'converted'].includes(status(p.id)?.outcome);

  if (!q) {
    const mine = me ? clients.filter((c) => c.assigned_to_code === me) : [];
    const area = new Set(areas.map((a) => lower(a).replace(/[^\p{L}\p{N}]/gu, '')));
    const inArea = (p) => area.has(lower(p.territory).replace(/[^\p{L}\p{N}]/gu, ''));

    return {
      clients: (mine.length ? mine : clients).slice(0, max),
      prospects: prospects.filter((p) => !closed(p) && (!area.size || inArea(p))).slice(0, max),
    };
  }

  const digits = q.replace(/\D/g, '');
  const wide = clients.filter((c) => `${c.name} ${c.company} ${c.city}`.toLowerCase().includes(q) || (digits.length >= 3 && (c.phone ?? '').replace(/\D/g, '').includes(digits)));
  const found = [...new Map([...searchClients(clients, text, max), ...wide].map((c) => [c.id, c])).values()].slice(0, max);

  return {
    clients: found,
    prospects: prospects.filter((p) => status(p.id)?.outcome !== 'do_not_call' && prospectMatches(p, text)).slice(0, max),
  };
}

// The planned time of each stop: the start, then ROUTE_MINUTES after each one before it.
export const plannedTimes = (start, count) => Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * ROUTE_MINUTES * MINUTE));

// A route is one day: the last stop must still be on the day of the first.
export const fitsOneDay = (times) => times.length === 0 || dayKey(times[0]) === dayKey(times.at(-1));

// The place most stops are in (the first one wins a tie), and the name that follows from it ("Bagru run").
export function areaOf(stops) {
  const count = new Map();
  for (const s of stops) {
    const key = lower(s.place);
    if (key) count.set(key, { place: count.get(key)?.place ?? s.place, n: (count.get(key)?.n ?? 0) + 1 }); // the first spelling stays
  }
  return [...count.values()].sort((a, b) => b.n - a.n)[0]?.place ?? '';
}

export const titleFor = (stops) => routeTitleFor(areaOf(stops));
