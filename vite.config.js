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

// The map picker (client location) uses Google Maps. The key is a build setting (GitHub variable GOOGLE_MAPS_KEY -> VITE_GOOGLE_MAPS_KEY).
// Without a key the build has no map (the rep pastes the numbers instead) and the policy below stays as strict as before. A Google Maps key
// is meant to sit inside an app: it is restricted in Google Cloud to this app's address and to the two APIs it needs.
const MAPS_JS = 'https://maps.googleapis.com/maps/api/js';
const PLACES = 'https://places.googleapis.com/v1/places:searchText';

function mapSettings(env) {
  const key = (env.VITE_GOOGLE_MAPS_KEY ?? '').trim();
  if (key && !/^[A-Za-z0-9_-]{20,80}$/.test(key)) throw new Error('VITE_GOOGLE_MAPS_KEY does not look like a Google Maps key.');

  return { key, js: key ? MAPS_JS : '', places: key ? PLACES : '' };
}

// The release build gets a strict Content-Security-Policy: only the app's own files run, almost nothing is loaded from the internet, and
// data can be sent to the office server only (connect-src). With a Google Maps key it also allows what Google Maps needs (its own guide):
// its scripts, pictures, fonts and the inline styles it adds itself. The dev server does not get a policy (it needs a websocket).
function policy(origin, maps) {
  const g = Boolean(maps.key);

  return [
    "default-src 'self'",
    `script-src 'self'${g ? ' https://maps.googleapis.com https://*.gstatic.com' : ''}`,
    `style-src 'self'${g ? " 'unsafe-inline' https://fonts.googleapis.com" : ''}`,
    `img-src 'self' blob: data:${g ? ' https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com' : ''}`,
    `font-src 'self'${g ? ' https://fonts.gstatic.com' : ''}`,
    `connect-src 'self'${origin ? ` ${origin}` : ''}${g ? ' https://*.googleapis.com https://*.google.com https://*.gstatic.com' : ''}`,
    ...(g ? ["worker-src blob:"] : []),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const maps = mapSettings(env);
  const csp = command === 'build' ? policy(serverOrigin(env), maps) : null;

  return {
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __MAPS_KEY__: JSON.stringify(maps.key),
      __MAPS_JS__: JSON.stringify(maps.js),
      __PLACES_URL__: JSON.stringify(maps.places),
    },
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
