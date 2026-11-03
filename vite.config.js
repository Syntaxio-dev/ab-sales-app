import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';

// One place for the version: package.json. The app shows it as v1.0 and CI names the APK after it.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The office address is fixed when the app is built (VITE_SERVER_URL; in CI the GitHub variable SERVER_URL).
// Only an https address is allowed into the Content-Security-Policy.
function serverOrigin(env) {
  const address = (env.VITE_SERVER_URL ?? '').trim();
  if (!address) return '';

  const url = new URL(address);
  if (url.protocol !== 'https:') throw new Error('VITE_SERVER_URL must be an https address for a build.');

  return url.origin;
}

// The map picker (client location): where the map pictures and the place search come from. Fixed at build time like the office
// address, so the app can only ever talk to these two hosts besides the office. Empty = no map in this build.
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const GEOCODER = 'https://nominatim.openstreetmap.org/search';

function mapOrigins(env) {
  const tiles = (env.VITE_MAP_TILES ?? TILES).trim();
  const geocoder = (env.VITE_GEOCODER_URL ?? GEOCODER).trim();
  const origin = (address) => {
    if (!address) return '';
    const url = new URL(address.replace(/\{[xyz]\}/g, '0'));
    if (url.protocol !== 'https:') throw new Error('The map addresses must be https.');
    return url.origin;
  };

  return { tiles, geocoder, tilesOrigin: origin(tiles), geocoderOrigin: origin(geocoder) };
}

// The release build gets a strict Content-Security-Policy: only the app's own files run, nothing is loaded from the
// internet, and data can be sent to the office server only (connect-src). The dev server does not get it (it needs a websocket).
function policy(origin, maps) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' blob: data:${maps.tilesOrigin ? ` ${maps.tilesOrigin}` : ''}`,
    "font-src 'self'",
    `connect-src 'self'${origin ? ` ${origin}` : ''}${maps.geocoderOrigin ? ` ${maps.geocoderOrigin}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const maps = mapOrigins(env);
  const csp = command === 'build' ? policy(serverOrigin(env), maps) : null;

  return {
    define: { __APP_VERSION__: JSON.stringify(version), __MAP_TILES__: JSON.stringify(maps.tiles), __GEOCODER_URL__: JSON.stringify(maps.geocoder) },
    build: { target: 'es2022', sourcemap: false },
    plugins: [
      {
        name: 'ab-sales-csp',
        apply: 'build',
        transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
      },
    ],
  };
});
