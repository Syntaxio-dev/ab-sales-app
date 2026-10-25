import { normalizePhone } from './phone.js';

// Every rule that decides whether typed text may be saved. Forms call these and the store calls them again,
// so a bug in a screen can never save a bad record. Each returns an error message, or null when the value is fine.

export const MAX_NOTE = 1000;
export const MAX_TEXT = 200;
export const MAX_LONG_TEXT = 2000;
export const MAX_EXPENSE_RUPEES = 1_000_000; // the office server will use the same limit
export const MAX_BILL_BYTES = 5 * 1024 * 1024;
export const CATEGORIES = ['travel', 'food', 'lodging', 'fuel', 'other'];

export function required(value, { min = 1, max = MAX_TEXT, label = 'This field' } = {}) {
  const text = String(value ?? '').trim();
  if (text.length < min) return min <= 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`;
  if (text.length > max) return `${label} can have at most ${max} characters.`;
  return null;
}

export function optional(value, { max = MAX_TEXT, label = 'This field' } = {}) {
  return String(value ?? '').trim().length > max ? `${label} can have at most ${max} characters.` : null;
}

export function employeeCode(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9-]{3,30}$/.test(text) ? null : 'Use 3 to 30 letters, numbers or "-".';
}

// A position (job title) in the shared list: the office server uses the same pattern.
export const POSITION_PATTERN = /^[\p{L}\p{N} &/().,'-]+$/u;

export function position(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 2 || text.length > 60) return 'A position is 2 to 60 letters or digits.';
  return POSITION_PATTERN.test(text) ? null : 'Use letters, digits and & / ( ) . , - only.';
}

export function phone(value, requiredField = false) {
  const text = String(value ?? '').trim();
  if (!text) return requiredField ? 'Phone number is required.' : null;
  return normalizePhone(text) ? null : 'Enter a valid phone number (10 digits, or with country code).';
}

// "1,234.50" -> 123450 (paise). Money is kept as whole paise so nothing is lost to rounding.
export function parsePaise(value) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return parseInt(match[1], 10) * 100 + parseInt((match[2] ?? '').padEnd(2, '0'), 10);
}

export function amount(value) {
  const paise = parsePaise(value);
  if (paise === null) return 'Enter an amount like 450 or 450.50.';
  if (paise <= 0) return 'Amount must be more than 0.';
  if (paise > MAX_EXPENSE_RUPEES * 100) return 'Amount is too large.';
  return null;
}

export function amountPaise(paise) {
  return Number.isInteger(paise) && paise > 0 && paise <= MAX_EXPENSE_RUPEES * 100 ? null : 'Amount is not valid.';
}

// "YYYY-MM-DD". Not more than one day ahead (clock differences), and not before 2020.
export function expenseDate(day, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return 'Pick a date.';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return 'Pick a real date.';
  if (y < 2020) return 'The date is too old.';

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return date.getTime() > today.getTime() + 86_400_000 ? 'The date cannot be in the future.' : null;
}

// Six digits, and not an easy guess: no repeated digit (111111), no run (123456, 654321).
export function pin(value) {
  const text = String(value ?? '');
  if (!/^\d{6}$/.test(text)) return 'PIN must be exactly 6 digits.';

  const digits = [...text].map(Number);
  if (digits.every((n) => n === digits[0])) return 'Do not use the same digit six times.';

  const steps = digits.slice(1).map((n, i) => n - digits[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'Do not use a run like 123456.';

  return null;
}

// Pictures are judged by their first bytes (a renamed file is not enough). Only JPEG, PNG and WebP are kept.
export function imageKind(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp';
  return null;
}

export function firstError(...errors) {
  return errors.find((e) => e) ?? null;
}
