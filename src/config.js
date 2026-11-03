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

// The map picker's two addresses (the map pictures and the place search). They come from the build (vite.config.js defines them), exactly
// like the office address, and the Content-Security-Policy lists only these. Empty = no map in this build.
export const MAP_TILES = typeof __MAP_TILES__ === 'string' ? __MAP_TILES__ : '';
export const GEOCODER_URL = typeof __GEOCODER_URL__ === 'string' ? __GEOCODER_URL__ : '';
