import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// Rules that must hold for every line of the app's own code. They guard the owner's standing rules
// (security first, offline, no tracking) so a later change cannot break them by accident.

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const js = files(SRC).filter((f) => f.endsWith('.js'));
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may mention the words

function offenders(pattern, { except = [] } = {}) {
  return js
    .filter((file) => !except.some((e) => relative(SRC, file).replace(/\\/g, '/') === e))
    .filter((file) => pattern.test(strip(readFileSync(file, 'utf8'))))
    .map((file) => relative(SRC, file));
}

test('there are source files to check', () => {
  assert.ok(js.length > 15, `only ${js.length} files found`);
});

test('typed text is never turned into HTML', () => {
  // dom.js names the words only to refuse them
  assert.deepEqual(offenders(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\.srcdoc\s*=/, { except: ['ui/dom.js'] }), []);
  assert.deepEqual(offenders(/\binnerHTML\b|\bouterHTML\b/, { except: ['ui/dom.js'] }), []);
});

test('no dynamic code', () => {
  assert.deepEqual(offenders(/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]/), []);
});

test('the network is touched in ONE file only (src/sync/http.js), and only with fetch', () => {
  assert.deepEqual(offenders(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.connection|importScripts/), []);
  assert.deepEqual(offenders(/\bfetch\s*\(/, { except: ['sync/http.js'] }), []);
});

test('the network file is strict: https only, no cookies, no redirects, nothing cached, a time limit', () => {
  const http = strip(readFileSync(join(SRC, 'sync', 'http.js'), 'utf8'));

  for (const needle of ["redirect: 'error'", "credentials: 'omit'", "cache: 'no-store'", 'AbortController', 'assertSecureBase', "'https:'"]) {
    assert.ok(http.includes(needle), `sync/http.js must keep: ${needle}`);
  }
});

test('the office address comes from the build (src/config.js) and is never typed or read from storage', () => {
  assert.deepEqual(offenders(/import\.meta\.env/, { except: ['config.js'] }), []);
});

test('no analytics, tracking or remote scripts, and no web address written into the code', () => {
  assert.deepEqual(offenders(/google-analytics|gtag\s*\(|firebase|mixpanel|sentry|https?:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org)[a-z0-9]/i), []);
});

test('browser storage is touched only by the preview platform, its own storage class and the theme choice', () => {
  // ui/theme.js keeps the light / dark choice (not secret). Records and keys never go through it.
  assert.deepEqual(offenders(/\blocalStorage\b|\bsessionStorage\b|indexedDB/, { except: ['platform/web.js', 'data/persist.js', 'ui/theme.js'] }), []);
});

test('nothing personal is written to the console', () => {
  const logs = js.flatMap((file) => strip(readFileSync(file, 'utf8')).split('\n').filter((line) => /console\.(log|info|debug|dir|table)\b/.test(line)).map((line) => `${relative(SRC, file)}: ${line.trim()}`));
  assert.deepEqual(logs, []);
});

test('the PIN and keys never go into the data store or the logs', () => {
  assert.deepEqual(offenders(/persist\.set\([^)]*\bpin\b/i), []);
});

// ---- call matching (the phone's call history) ----

test('the call history is reached only through the platform file, and the raw rows are never stored or sent as they are', () => {
  // only platform/native.js talks to the plugin; the rest of the app asks the platform object
  assert.deepEqual(offenders(/registerPlugin|CallLogReader/, { except: ['platform/native.js'] }), []);

  // a raw call-log row (data from the phone's history) is turned into a record only in matcher.js, which keeps pool numbers only
  // (any spelling: through an alias too)
  assert.deepEqual(offenders(/\brecent\(\s*\{\s*sinceMs/, { except: ['app.js', 'platform/native.js', 'platform/web.js'] }), []);
});

test('call matching is opt-in: nothing is read unless the person turned it on', () => {
  const app = strip(readFileSync(join(SRC, 'app.js'), 'utf8'));
  assert.match(app, /prefs\.call_matching !== true/);
});

test('the manifest asks for the internet and the call history, nothing else of its own', () => {
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const permissions = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(permissions, ['android.permission.INTERNET', 'android.permission.READ_CALL_LOG']);
});

test('the native call-history reader only reads', () => {
  const java = readFileSync(new URL('../android/app/src/main/java/com/agarwalbrothers/sales/CallLogReaderPlugin.java', import.meta.url), 'utf8');
  assert.doesNotMatch(java, /\.insert\(|\.delete\(|\.update\(|WRITE_CALL_LOG|CALL_PHONE|READ_SMS/);
});
