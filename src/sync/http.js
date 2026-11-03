// The ONLY place in the app that talks to the network (a source test fails if fetch appears anywhere else).
// Rules: HTTPS only (plain http just for a server on this computer, in the development build), no cookies, no redirects,
// nothing cached, a time limit on every call, and the token goes only to the one address the app was built with.

export class SyncError extends Error {
  constructor(code, message, status = 0, errors = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.errors = errors;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function assertSecureBase(base, allowLocalHttp = false) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new SyncError('BAD_URL', 'The office address is not valid.');
  }

  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && local && allowLocalHttp)) return url;

  throw new SyncError('INSECURE_URL', 'The office address must start with https://.');
}

// opts: { base, fetchFn, timeoutMs, allowLocalHttp, appVersion }
export function createHttp({ base, fetchFn = (...args) => fetch(...args), timeoutMs = 30_000, allowLocalHttp = false, appVersion = '' }) {
  const root = assertSecureBase(base, allowLocalHttp).toString().replace(/\/+$/, '');

  async function request(method, path, { token = null, body = undefined, query = null } = {}) {
    const url = new URL(`${root}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) if (value !== null && value !== undefined) url.searchParams.set(name, String(value));

    // never send the token anywhere but the configured server
    if (url.origin !== new URL(root).origin) throw new SyncError('BAD_URL', 'Refused to call another address.');

    const headers = { Accept: 'application/json' };
    if (appVersion) headers['X-App-Version'] = appVersion;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetchFn(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new SyncError('OFFLINE', 'Could not reach the office. Check the internet; the app will try again later.');
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      // not JSON (a proxy error page, for example)
    }

    if (!response.ok) {
      throw new SyncError(
        typeof data?.code === 'string' ? data.code : `HTTP_${response.status}`,
        typeof data?.message === 'string' ? data.message : 'The office answered with an error.',
        response.status,
        data?.errors && typeof data.errors === 'object' ? data.errors : {},
      );
    }

    if (data === null || typeof data !== 'object') throw new SyncError('BAD_RESPONSE', 'The office answered in a way the app does not understand.', response.status);

    return data;
  }

  return {
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
  };
}

// Search a place by name for the map picker (Google Places, text search: shops, colleges, factories, addresses). Only the typed words, the
// build's map key and a rough area leave the phone: no office token, no cookies, no identity. -> [{ name, lat, lng }], at most 6, India.
// Throws SyncError('OFFLINE') when it cannot be reached.
export async function searchPlaces(query, { base, key, near = null, fetchFn = (...args) => fetch(...args), timeoutMs = 12_000 } = {}) {
  const text = String(query ?? '').replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (text.length < 3 || !base || !key) return [];

  const url = assertSecureBase(base, false).toString();
  const body = { textQuery: text, regionCode: 'IN', maxResultCount: 6 };
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
    body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'strict-origin',
    });
    if (!response.ok) throw new Error('bad answer');

    const answer = await response.json();
    const rows = Array.isArray(answer?.places) ? answer.places : [];

    return rows.slice(0, 6).map((r) => {
      const title = String(r?.displayName?.text ?? '').trim();
      const address = String(r?.formattedAddress ?? '').trim();
      return { name: [title, address].filter(Boolean).join(', ').slice(0, 180), lat: Number(r?.location?.latitude), lng: Number(r?.location?.longitude) };
    }).filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180 && !(r.lat === 0 && r.lng === 0));
  } catch {
    throw new SyncError('OFFLINE', 'Could not search. Check the internet.');
  } finally {
    clearTimeout(timer);
  }
}
