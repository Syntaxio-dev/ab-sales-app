// Follow-up reminders (v1.15): which notifications the phone should have scheduled, worked out from the leads. Pure functions.
//
// PRIVACY: the text is always the same and names nobody. A notification can show on the lock screen (and the app itself hides its
// screen with FLAG_SECURE), so a client's name must never be in it. The rep opens the app (PIN) and sees which lead it is.
import { isOpen } from './enquiry.js';

export const MAX_REMINDERS = 60;          // the soonest ones; the plan is made again whenever the leads change or the app opens
export const REMINDER_TITLE = 'AB Sales';
export const REMINDER_BODY = 'A follow-up is due. Open the Leads tab.';

// A stable positive 31-bit number for a record id (Android notification ids are ints). FNV-1a.
export function reminderId(uuid) {
  let hash = 0x811c9dc5;
  for (const ch of String(uuid)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2_147_483_647 || 1;
}

// -> [{ id, at (ms), title, body }], soonest first: one per open enquiry that has a reminder still ahead
export function planReminders(enquiries, now = Date.now()) {
  const seen = new Set();
  const plan = [];

  for (const e of [...enquiries].sort((a, b) => Date.parse(a.next_followup_at ?? 0) - Date.parse(b.next_followup_at ?? 0))) {
    if (!isOpen(e.status) || !e.next_followup_at) continue;

    const at = Date.parse(e.next_followup_at);
    if (!Number.isFinite(at) || at <= now) continue;

    const id = reminderId(e.id);
    if (seen.has(id)) continue; // two records can (very rarely) share a number: the later one is skipped, it is still in the Leads tab
    seen.add(id);
    plan.push({ id, at, title: REMINDER_TITLE, body: REMINDER_BODY });
    if (plan.length >= MAX_REMINDERS) break;
  }
  return plan;
}

// Two plans that mean the same thing have the same key (so the phone is only told when something changed).
export const planKey = (plan) => plan.map((r) => `${r.id}@${r.at}`).join('|');
