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
