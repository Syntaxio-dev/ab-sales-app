import { deterministicId } from '../core/ids.js';
import { normalizePhone } from '../core/phone.js';

// Turns the phone's call log into the calls that matter: only calls with a number saved in the client pool are kept (and later
// sent to the office). Every other call (family, friends, anybody not in the pool) is dropped on the spot: it is never stored,
// never sent and never logged.

export const LOOKBACK_DAYS = 30;
export const MAX_ROWS = 500;

// Android's CallLog.Calls.TYPE: 1 incoming, 2 outgoing, 3 missed, 5 rejected. Voicemail (4), blocked (6) and the rest are skipped.
export function directionOf(type) {
  if (type === 1) return 'incoming';
  if (type === 2) return 'outgoing';
  if (type === 3 || type === 5) return 'missed';
  return null;
}

// The same call always gets the same id (rep + number + start + direction), so importing the log twice, or on a second phone, never
// makes a call twice: the office answers "duplicate".
export const callId = (repCode, number, startedAtMs, direction) => deterministicId(repCode, number, startedAtMs, direction);

/**
 * @param raw   [{ number, type, date (ms), duration (s) }] from the phone's call log
 * @param store the store (it knows the pool: store.matchNumber)
 * @returns { matched: records for store.saveCalls, unknown: [{ number, last, count, direction }] newest first }
 */
export async function matchCalls(raw, store, repCode) {
  const matched = [];
  const unknown = new Map();

  for (const row of Array.isArray(raw) ? raw : []) {
    const direction = directionOf(row?.type);
    const number = normalizePhone(row?.number);
    const started = Number(row?.date);
    const seconds = Math.max(0, Math.min(86_400, Math.round(Number(row?.duration) || 0)));

    if (!direction || !number || !Number.isFinite(started) || started <= 0) continue; // a hidden number, a short code, voicemail ...

    const who = store.matchNumber(number);

    if (!who) {
      const seen = unknown.get(number);
      if (!seen) unknown.set(number, { number, last: started, count: 1, direction });
      else {
        seen.count++;
        if (started > seen.last) Object.assign(seen, { last: started, direction });
      }
      continue;
    }

    matched.push({
      id: await callId(repCode, number, started, direction),
      direction,
      number,
      client_id: who.client?.id ?? null, // a person without a company has no client
      contact_id: who.contact?.id ?? null,
      client_name: who.client?.name ?? '',
      contact_name: who.contact?.name ?? '',
      started_at: new Date(started).toISOString(),
      duration_seconds: direction === 'missed' ? 0 : seconds,
    });
  }

  return { matched, unknown: [...unknown.values()].sort((a, b) => b.last - a.last) };
}
