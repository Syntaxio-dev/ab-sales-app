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

test('the app makes no network calls at all (it works offline and nothing leaves the phone)', () => {
  assert.deepEqual(offenders(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.connection/), []);
});

test('no analytics, tracking or remote scripts', () => {
  assert.deepEqual(offenders(/google-analytics|gtag\s*\(|firebase|mixpanel|sentry|https?:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org)/i), []);
});

test('browser storage is touched only by the preview platform and its own storage class', () => {
  assert.deepEqual(offenders(/\blocalStorage\b|\bsessionStorage\b|indexedDB/, { except: ['platform/web.js', 'data/persist.js'] }), []);
});

test('nothing personal is written to the console', () => {
  const logs = js.flatMap((file) => strip(readFileSync(file, 'utf8')).split('\n').filter((line) => /console\.(log|info|debug|dir|table)\b/.test(line)).map((line) => `${relative(SRC, file)}: ${line.trim()}`));
  assert.deepEqual(logs, []);
});

test('the PIN and keys never go into the data store or the logs', () => {
  assert.deepEqual(offenders(/persist\.set\([^)]*\bpin\b/i), []);
});
