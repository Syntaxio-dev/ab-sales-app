import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { CLIENT_TYPES, cheatNotes, firstSentence, highlight, productsForClientType, searchProducts, searchScripts, withGuideDefaults } from '../src/core/guide.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanProduct, cleanScript } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

// The guide as a brief for a visit: who is being met, the manager's pitch and notes, the rep's own scripts, and the rep's place in it.

const BASE = 'https://office.example/api/sales/v1';
let office;
let key;

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const balance = {
  uuid: uuid(34), name: 'Lab Weighing Balance', group: 'Balances and weighing', sort: 34,
  premium_brands: ['Sartorius', 'Mettler Toledo'], economy_brands: ['Aczet'], lite_brands: [],
  summary: 'A balance weighs samples. It is the most common instrument in a lab.', variants: [], industries: '',
  key_parameters: ['What capacity is needed?', 'How often is it calibrated?'], short_term_problems: [], long_term_problems: [], top_brands: [],
  client_types: ['pharma_qc', 'food_dairy'], pitch: 'Weighs to **0.1 mg**, so your batches match.', key_notes: ['Draft shield matters', 'Calibrate yearly'],
  formula: 'readability = smallest step', do: ['Ask the capacity'], avoid: ['Quote before the room is seen'], match_rules: [{ if: 'Needs audit trail', then: 'Premium' }],
};
const centrifuge = {
  uuid: uuid(26), name: 'Micro Centrifuge', group: 'Centrifuges', sort: 26,
  premium_brands: [], economy_brands: ['DLAB'], lite_brands: ['Supertek'], summary: 'Spins small tubes.', variants: [], industries: '',
  key_parameters: [], short_term_problems: [], long_term_problems: [], top_brands: [], client_types: ['hospital'],
};

async function phone(code = 'REP001', persist = new MemoryPersist()) {
  const store = await Store.open(persist, key);
  if (!store.profile) await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '2.0', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine, persist };
}

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

// ---- the pieces of the brief ----

test('marked words become highlight parts, never HTML', () => {
  assert.deepEqual(highlight('Spins so the **heavy parts settle** fast'), ['Spins so the ', { hl: 'heavy parts settle' }, ' fast']);
  assert.deepEqual(highlight('plain'), ['plain']);
  assert.deepEqual(highlight('<b>x</b> **y**'), ['<b>x</b> ', { hl: 'y' }]); // the tag is only text: the screen puts it in a text node
  assert.deepEqual(highlight(''), []);
});

test('the one-liner is the first sentence, cut when it is long', () => {
  assert.equal(firstSentence('A balance weighs. It is common.'), 'A balance weighs.');
  assert.equal(firstSentence('No full stop here'), 'No full stop here');
  assert.ok(firstSentence('x'.repeat(400)).length <= 150);
  assert.equal(firstSentence('**Bold** idea. More.'), 'Bold idea.');
});

test('the cheat sheet shows the manager\'s notes, or a short version of what is in the guide, never more than five rows', () => {
  const p = withGuideDefaults({ ...cleanProduct(balance) });
  assert.deepEqual(cheatNotes(p).map((n) => n.text), ['Draft shield matters', 'Calibrate yearly']);

  const bare = { ...p, key_notes: [] };
  const rows = cheatNotes(bare);
  assert.deepEqual(rows.map((r) => r.label), ['Premium', 'Economy', 'Ask', 'Ask']);
  assert.equal(rows[0].text, 'Sartorius, Mettler Toledo');

  assert.ok(cheatNotes({ ...bare, key_parameters: Array.from({ length: 9 }, (_, i) => `Q${i}`) }).length <= 5);
});

test('a product is suggested for the kinds of client the manager marked it for', () => {
  const list = [cleanProduct(balance), cleanProduct(centrifuge)];
  assert.deepEqual(productsForClientType(list, 'pharma_qc').map((p) => p.name), ['Lab Weighing Balance']);
  assert.deepEqual(productsForClientType(list, 'hospital').map((p) => p.name), ['Micro Centrifuge']);
  assert.deepEqual(productsForClientType(list, 'water_environment'), []);
  assert.equal(CLIENT_TYPES.length, 6);
});

test('the new fields are cleaned like everything the office sends', () => {
  const p = cleanProduct({
    ...balance,
    client_types: ['pharma_qc', 'pharma_qc', 'made_up', 42],
    key_notes: Array.from({ length: 9 }, (_, i) => `n${i}`),
    do: ['a', 'b', 'c', 'd'], avoid: [1, 'x'],
    match_rules: [{ if: 'a', then: 'b' }, { if: '', then: 'c' }, 'junk', { if: 'z', then: 'y' }],
    pitch: 'p'.repeat(2000),
  });

  assert.deepEqual(p.client_types, ['pharma_qc']);
  assert.equal(p.key_notes.length, 5);
  assert.equal(p.do.length, 3);
  assert.deepEqual(p.avoid, ['x']);
  assert.deepEqual(p.match_rules, [{ if: 'a', then: 'b' }, { if: 'z', then: 'y' }]);
  assert.equal(p.pitch.length, 600);

  // an office that sends none of them (an older website) still gives a usable product
  const old = cleanProduct({ uuid: uuid(1), name: 'Old product' });
  assert.deepEqual([old.client_types, old.pitch, old.key_notes, old.do, old.avoid, old.match_rules], [[], '', [], [], [], []]);
});

test('searching also finds words of the pitch and the notes', () => {
  const list = [cleanProduct(balance), cleanProduct(centrifuge)];
  assert.equal(searchProducts(list, 'audit')[0], undefined, 'rules are not searched, only the pitch and the notes');
  assert.equal(searchProducts(list, 'batches')[0].product.name, 'Lab Weighing Balance');
  assert.equal(searchProducts(list, 'calibrate')[0].product.name, 'Lab Weighing Balance');
});

// ---- my scripts ----

test('a script is saved, changed and deleted on the phone, with the rules of a form', async () => {
  office.setProducts([balance]);
  const { store, engine } = await phone();
  await engine.syncNow();

  const s = await store.saveScript({ product_id: uuid(34), title: 'For pharma buyers', body: 'Good morning. Our balances weigh to 0.1 mg.' });
  assert.equal(s.product_name, 'Lab Weighing Balance');
  assert.equal(store.scriptsOf(uuid(34)).length, 1);

  await assert.rejects(() => store.saveScript({ product_id: uuid(34), body: 'ab' }), ValidationError);
  await assert.rejects(() => store.saveScript({ product_id: uuid(99), body: 'a long enough script' }), ValidationError, 'a product that is not in the guide');
  await assert.rejects(() => store.saveScript({ product_id: null, product_name: '', body: 'a long enough script' }), ValidationError, 'a name is needed without a product');
  await assert.rejects(() => store.saveScript({ product_id: uuid(34), body: 'x'.repeat(3001) }), ValidationError);

  const loose = await store.saveScript({ product_id: null, product_name: 'Muffle Furnace', body: 'Talks about the furnace.' });
  assert.equal(loose.product_id, null);

  const changed = await store.saveScript({ id: s.id, product_id: uuid(34), title: 'New title', body: 'A changed script.' });
  assert.equal(changed.created_at, s.created_at);
  assert.equal(store.scripts.length, 2);

  await store.deleteScript(s.id);
  assert.equal(store.scriptById(s.id), null);
});

test('scripts are found by title, product and words', () => {
  const list = [
    { id: '1', title: 'For pharma buyers', product_name: 'Lab Weighing Balance', body: 'Calibration is yearly.' },
    { id: '2', title: '', product_name: 'Muffle Furnace', body: 'Rated to 1200 degrees.' },
  ];
  assert.deepEqual(searchScripts(list, 'pharma').map((s) => s.id), ['1']);
  assert.deepEqual(searchScripts(list, 'furn degrees').map((s) => s.id), ['2']);
  assert.deepEqual(searchScripts(list, 'nothing here'), []);
  assert.equal(searchScripts(list, '').length, 2);
});

test('a rep\'s scripts reach the office, come back on a new phone, and nobody else gets them', async () => {
  office.setProducts([balance]);
  const a = await phone('REP001');
  const b = await phone('REP002');
  await a.engine.syncNow();

  const s = await a.store.saveScript({ product_id: uuid(34), title: 'Mine', body: 'My own pitch for balances.' });
  await a.engine.syncNow();
  assert.equal(a.store.unsyncedCount, 0);

  await b.engine.syncNow();
  assert.equal(b.store.scripts.length, 0, 'private to the rep');

  // a new phone of the same rep
  const fresh = await phone('REP001');
  await fresh.engine.syncNow();
  assert.equal(fresh.store.scripts.length, 1);
  assert.equal(fresh.store.scripts[0].body, 'My own pitch for balances.');
  assert.equal(fresh.store.scripts[0].product_name, 'Lab Weighing Balance');

  // a delete travels too (signing in on the new phone signed the first one out: one phone per rep)
  await fresh.store.deleteScript(s.id);
  await fresh.engine.syncNow();
  const third = await phone('REP001');
  await third.engine.syncNow();
  assert.equal(third.store.scripts.length, 0);
});

test('a script from the office that is broken or hostile is dropped or trimmed', () => {
  assert.equal(cleanScript({ uuid: 'nope', body: 'abc', product_name: 'xx', updated_at: new Date().toISOString() }), null);
  assert.equal(cleanScript({ uuid: uuid(1), body: 'ab', product_name: 'Balance', updated_at: new Date().toISOString() }), null);
  assert.equal(cleanScript({ uuid: uuid(1), body: 'abc', product_name: 'Balance', updated_at: 'yesterday' }), null);

  const ok = cleanScript({ uuid: uuid(1), product_uuid: 'not-a-uuid', body: `${'x'.repeat(5000)}`, product_name: 'Balance', title: 't'.repeat(500), updated_at: new Date().toISOString() });
  assert.equal(ok.product_id, null);
  assert.equal(ok.body.length, 3000);
  assert.equal(ok.title.length, 120);
});

// ---- the rep's place in the guide ----

test('ticks reset, learned stays, and only ids and yes / no are kept', async () => {
  const persist = new MemoryPersist();
  const { store } = await phone('REP001', persist);

  await store.tickGuideQuestion(uuid(34), 0);
  await store.tickGuideQuestion(uuid(34), 2);
  await store.tickGuideQuestion(uuid(34), 2); // ticking again unticks
  await store.setGuideLearned(uuid(34), true);
  await store.setGuideClientType('hospital');

  // junk is refused, not stored
  await store.tickGuideQuestion('', 0);
  await store.tickGuideQuestion(uuid(34), -1);
  await store.tickGuideQuestion(uuid(34), 1.5);
  await store.tickGuideQuestion(uuid(34), 500);
  await store.tickGuideQuestion({ evil: true }, 0);
  await store.setGuideClientType('<script>');

  let progress = store.guideProgress;
  assert.deepEqual(progress.ticks, { [uuid(34)]: [0] });
  assert.deepEqual(progress.learned, { [uuid(34)]: true });
  assert.equal(progress.client_type, null, 'an unknown kind of client is not kept');

  // it survives closing and opening the app
  await store.setGuideClientType('hospital');
  const again = await Store.open(persist, key);
  progress = again.guideProgress;
  assert.equal(progress.client_type, 'hospital');
  assert.deepEqual(progress.learned, { [uuid(34)]: true });
  assert.deepEqual(progress.ticks, { [uuid(34)]: [0] });

  // everything stored is an id with numbers or true, or the id of a kind of client
  const shape = JSON.stringify(progress);
  assert.match(shape, /^[{}\[\]":,0-9a-z_\-truefalsnl]*$/);

  await again.resetGuideTicks(uuid(34));
  assert.deepEqual(again.guideProgress.ticks, {});
  assert.deepEqual(again.guideProgress.learned, { [uuid(34)]: true }, 'learned persists through a reset');

  await again.setGuideLearned(uuid(34), false);
  assert.deepEqual(again.guideProgress.learned, {});
});

test('the progress and the scripts go when the phone is erased for another rep', async () => {
  office.setProducts([balance]);
  const { store, engine } = await phone();
  await engine.syncNow();
  await store.saveScript({ product_id: uuid(34), body: 'A script for the balance.' });
  await store.setGuideLearned(uuid(34), true);

  await store.wipeEverything();
  assert.equal(store.scripts.length, 0);
  assert.deepEqual(store.guideProgress, { learned: {}, ticks: {}, client_type: null });
});

test('a guide saved before the new fields existed still opens, with empty defaults', async () => {
  const persist = new MemoryPersist();
  const { store } = await phone('REP001', persist);
  const { client_types, pitch, key_notes, formula, do: d, avoid, match_rules, ...oldShape } = cleanProduct(balance); // what v1.5 stored
  await store.setGuideFromServer({ version: 'old', products: [oldShape] });

  const again = await Store.open(persist, key);
  const p = again.guideProducts[0];
  assert.deepEqual([p.client_types, p.pitch, p.key_notes, p.do, p.match_rules], [[], '', [], [], []]);
});
