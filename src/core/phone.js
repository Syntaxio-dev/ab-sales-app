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
