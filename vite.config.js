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

// The release build gets a strict Content-Security-Policy: only the app's own files run, nothing is loaded from the
// internet, and data can be sent to the office server only (connect-src). The dev server does not get it (it needs a websocket).
function policy(origin) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${origin ? ` ${origin}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const csp = command === 'build' ? policy(serverOrigin(env)) : null;

  return {
    define: { __APP_VERSION__: JSON.stringify(version) },
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
