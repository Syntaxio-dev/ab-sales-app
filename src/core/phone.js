// One spelling for a phone number, so "98765 43210", "09876543210" and "+91 98765-43210" are the same client.
// Indian mobile numbers get +91; any other number needs its own country code. Returns null when unusable.
export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;

  const text = String(raw).trim();
  const plus = text.startsWith('+') || text.startsWith('00');
  let digits = text.replace(/\D+/g, '');

  if (text.startsWith('00')) digits = digits.slice(2);
  if (!digits) return null;

  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;

  if (digits.length === 10 && digits[0] >= '6') return `+91${digits}`;
  if (digits.length === 11 && digits[0] === '0') return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;

  return null;
}

// ---- the phone box on a form: a country code and the number, never free text ---------------------------------------
//
// India is the default and strict: exactly 10 digits. The other countries have the length(s) their numbers really have, so a
// typing slip (a digit too many or too few) is caught on the phone and never reaches the office.

export const COUNTRIES = [
  { code: '91', iso: 'IN', name: 'India', min: 10, max: 10 },
  { code: '971', iso: 'AE', name: 'UAE', min: 8, max: 9 },
  { code: '977', iso: 'NP', name: 'Nepal', min: 8, max: 10 },
  { code: '880', iso: 'BD', name: 'Bangladesh', min: 10, max: 10 },
  { code: '94', iso: 'LK', name: 'Sri Lanka', min: 9, max: 9 },
  { code: '975', iso: 'BT', name: 'Bhutan', min: 8, max: 8 },
  { code: '92', iso: 'PK', name: 'Pakistan', min: 10, max: 10 },
  { code: '966', iso: 'SA', name: 'Saudi Arabia', min: 9, max: 9 },
  { code: '968', iso: 'OM', name: 'Oman', min: 8, max: 8 },
  { code: '974', iso: 'QA', name: 'Qatar', min: 8, max: 8 },
  { code: '965', iso: 'KW', name: 'Kuwait', min: 8, max: 8 },
  { code: '65', iso: 'SG', name: 'Singapore', min: 8, max: 8 },
  { code: '60', iso: 'MY', name: 'Malaysia', min: 9, max: 10 },
  { code: '66', iso: 'TH', name: 'Thailand', min: 9, max: 9 },
  { code: '86', iso: 'CN', name: 'China', min: 11, max: 11 },
  { code: '81', iso: 'JP', name: 'Japan', min: 10, max: 10 },
  { code: '44', iso: 'GB', name: 'United Kingdom', min: 10, max: 10 },
  { code: '49', iso: 'DE', name: 'Germany', min: 10, max: 11 },
  { code: '61', iso: 'AU', name: 'Australia', min: 9, max: 9 },
  { code: '1', iso: 'US', name: 'USA / Canada', min: 10, max: 10 },
];

export const DEFAULT_COUNTRY = '91';

// A country code that is not in the list (an old number, or one typed by the office): kept as it is, with a sensible length.
const unknownCountry = (code) => ({ code, iso: `+${code}`, name: `+${code}`, min: 6, max: 14 });

export const countryOf = (code) => COUNTRIES.find((c) => c.code === code) ?? unknownCountry(code);

/** "+919876543210" -> { country: '91', national: '9876543210' }. A blank or unreadable value gives India and an empty number. */
export function splitPhone(stored) {
  const normal = normalizePhone(stored);
  if (!normal) return { country: DEFAULT_COUNTRY, national: '' };

  const digits = normal.slice(1);
  const known = [...COUNTRIES].sort((a, b) => b.code.length - a.code.length).find((c) => digits.startsWith(c.code));
  if (known) return { country: known.code, national: digits.slice(known.code.length) };

  return { country: digits.slice(0, 3), national: digits.slice(3) };
}

/** { country: '91', national: '98765 43210' } -> "+919876543210", or '' when the number box is empty. */
export function joinPhone(country, national) {
  const digits = String(national ?? '').replace(/\D+/g, '');
  return digits ? `+${country}${digits}` : '';
}

/**
 * Is this country + number acceptable? Returns a message, or null.
 * `landline`: an office board number is allowed (a landline with its area code can start with any digit 1-9), not only a mobile.
 */
export function phoneProblem(country, national, { landline = false } = {}) {
  const digits = String(national ?? '').replace(/\D+/g, '');
  const c = countryOf(country);

  if (!digits) return null;
  if (digits.length < c.min || digits.length > c.max) {
    return c.min === c.max ? `The number needs exactly ${c.min} digits (${c.name}).` : `The number needs ${c.min} to ${c.max} digits (${c.name}).`;
  }

  if (c.code === '91') {
    if (landline) return /^[1-9]/.test(digits) ? null : 'An Indian number cannot start with 0.';
    return /^[6-9]/.test(digits) ? null : 'An Indian mobile number starts with 6, 7, 8 or 9.';
  }

  return /^0/.test(digits) ? 'Leave out the 0 at the start: the country code replaces it.' : null;
}
