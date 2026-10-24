import { NumberCell, toCsv } from '../core/csv.js';
import { formatDay, formatDayTime, parseDay } from './format.js';

// Builds export files from the store. They are made in memory and handed to the system share sheet
// (platform.shareFile); bill photos are not part of an export.

const money = (paise) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;

export function expensesCsv(store) {
  return toCsv([
    ['Date', 'Category', 'Amount (INR)', 'Note', 'Has bill', 'Status', 'Id'],
    ...store.expenses.map((e) => [formatDay(parseDay(e.expense_date)), e.category, new NumberCell(money(e.amount_paise)), e.note, e.has_bill ? 'yes' : 'no', e.status, e.id]),
  ]);
}

export function clientsCsv(store) {
  return toCsv([
    ['Name', 'Company', 'Phone', 'City', 'Notes', 'Id'],
    ...store.clients.map((c) => [c.name, c.company, c.phone, c.city, c.notes, c.id]),
  ]);
}

export function meetingsCsv(store) {
  return toCsv([
    ['When', 'Client', 'Purpose', 'Discussion', 'Outcome', 'Follow-up', 'Id'],
    ...store.meetings.map((m) => [
      formatDayTime(new Date(m.meeting_at)), m.client_name, m.purpose, m.discussion, m.outcome,
      m.next_followup_at ? formatDayTime(new Date(m.next_followup_at)) : '', m.id,
    ]),
  ]);
}

export const allJson = (store) => JSON.stringify(store.exportAll(), null, 2);
