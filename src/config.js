// The office server's address. It is fixed when the app is BUILT (GitHub variable SERVER_URL for the APK, .env.development for
// local work), so a rep can never be sent to another server by typing an address. Empty = the app has no office link and
// works on its own, exactly like version 1.2.
//
// The module can move to its own sub-domain later: change the variable and ship a new version.

const address = String(import.meta.env?.VITE_SERVER_URL ?? '').trim().replace(/\/+$/, '');

export const SERVER_URL = address;
export const API_BASE = address ? `${address}/api/sales/v1` : '';

// Plain http is only allowed for a server on this very computer, and only in the development build.
export const ALLOW_LOCAL_HTTP = Boolean(import.meta.env?.DEV);

// Google Maps for the client-location picker. The key and the two addresses come from the build (vite.config.js defines them), exactly like
// the office address; the Content-Security-Policy lists what Google Maps needs only when a key is set. No key = no map in this build.
export const MAPS_KEY = typeof __MAPS_KEY__ === 'string' ? __MAPS_KEY__ : '';
export const MAPS_JS_URL = typeof __MAPS_JS__ === 'string' ? __MAPS_JS__ : '';
export const PLACES_URL = typeof __PLACES_URL__ === 'string' ? __PLACES_URL__ : '';
