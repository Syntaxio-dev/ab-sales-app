const group = new Intl.NumberFormat('en-IN');
const dayFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

// 123456 paise -> "₹1,234.56" with Indian digit grouping (12,34,567.00). Integer maths only: no float rounding.
export function rupees(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}₹${group.format(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

export const pad = (n) => String(n).padStart(2, '0');

// A local calendar day as "YYYY-MM-DD" (what an expense stores).
export function dayString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDay(text) {
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const formatDay = (date) => dayFormat.format(date);
export const formatTime = (date) => timeFormat.format(date);
export const formatDayTime = (date) => `${dayFormat.format(date)}, ${timeFormat.format(date)}`;

export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function dayLabel(date, now = new Date()) {
  if (sameDay(date, now)) return 'Today';
  if (sameDay(date, new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  return formatDay(date);
}

export const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

// <input type="datetime-local"> value <-> Date (local time, no seconds)
export const toLocalInput = (date) => `${dayString(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
export const fromLocalInput = (text) => (text ? new Date(text) : null);
