// Thin helpers over the browser's built-in WebCrypto (the same engine in Chrome, the Android WebView and Node).
// No crypto code of our own: only PBKDF2, HMAC-SHA256 and AES-256-GCM, with random values from crypto.getRandomValues.

const encoder = new TextEncoder();

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8(text) {
  return encoder.encode(text);
}

export function fromUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

// PIN -> 32 bytes. Slow on purpose: every guess costs `iterations` rounds.
export async function pbkdf2(pin, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256);
  return new Uint8Array(bits);
}

export async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// Raw 32 bytes -> a key that can only encrypt and decrypt (it cannot be exported again).
export function aesKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Result: 12 random bytes (iv) followed by the ciphertext and the 16 byte authentication tag.
// `context` is authenticated too, so a record copied into another slot fails to decrypt.
export async function seal(key, plain, context = '') {
  const iv = randomBytes(12);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(context) }, key, plain));

  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return out;
}

// Throws when the key is wrong, the data was changed, or the context does not match.
export async function open(key, sealed, context = '') {
  const iv = sealed.subarray(0, 12);
  const cipher = sealed.subarray(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(context) }, key, cipher));
}
