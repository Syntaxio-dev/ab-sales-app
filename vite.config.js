import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// One place for the version: package.json. The app shows it as v1.0 and CI names the APK after it.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The release build gets a strict Content-Security-Policy: only the app's own files run, nothing is loaded from the
// internet, and nothing can be sent anywhere (connect-src 'self'). The dev server does not get it (it needs a websocket).
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { target: 'es2022', sourcemap: false },
  plugins: [
    {
      name: 'ab-sales-csp',
      apply: 'build',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
    },
  ],
});
