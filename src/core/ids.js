// An id that is the same every time it is made from the same parts. A call, or a rep's report of one day, must be one row however many
// times (and on however many phones) it is made, so its id comes from what it is, never from chance.

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function deterministicId(...parts) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|'))));
  const h = hex(digest.slice(0, 16)).split('');
  h[12] = '5'; // looks like a version 5 UUID
  h[16] = '89ab'[digest[8] % 4];
  const t = h.join('');

  return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20, 32)}`;
}

// one report per rep per day
export const reportId = (repCode, day) => deterministicId('report', repCode, day);
