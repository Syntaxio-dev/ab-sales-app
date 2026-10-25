import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { groupsOf, searchProducts } from '../src/core/guide.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanGuide, cleanProduct } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

// The product guide: the manager writes it, every phone keeps a copy, a rep can only ask for a change.

const BASE = 'https://office.example/api/sales/v1';
let office;
let key;

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const balance = {
  uuid: uuid(34), name: 'Lab Weighing Balance', group: 'Balances and weighing', sort: 34,
  premium_brands: ['Sartorius'], economy_brands: ['Aczet', 'Labindia'], lite_brands: [],
  summary: 'A balance weighs samples with high accuracy.',
  variants: [{ name: 'Analytical balances', text: 'Readability 0.1 mg to 0.01 mg.' }],
  industries: '', key_parameters: ['What capacity is needed?'],
  short_term_problems: ['Drafts cause drift.'], long_term_problems: ['Load cell fatigue.'],
  top_brands: [{ name: 'Mettler Toledo', note: 'Premium industry standard.' }],
};
const centrifuge = {
  uuid: uuid(26), name: 'Micro Centrifuge', group: 'Centrifuges', sort: 26,
  premium_brands: [], economy_brands: ['DLAB'], lite_brands: ['Supertek'],
  summary: 'Spins small tubes.', variants: [], industries: '', key_parameters: [],
  short_term_problems: ['Rotor imbalance alarms.'], long_term_problems: [], top_brands: [],
};

async function phone(code = 'REP001') {
  const store = await Store.open(new MemoryPersist(), key);
  await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '2.0', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine, http };
}

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

// ---- getting the guide ----

test('the guide comes to the phone with the sync, and a second sync does not fetch it again', async () => {
  office.setProducts([balance, centrifuge]);
  const { store, engine } = await phone();

  await engine.syncNow();
  assert.equal(store.guideProducts.length, 2);
  assert.equal(store.productById(balance.uuid).name, 'Lab Weighing Balance');
  assert.deepEqual(store.productById(balance.uuid).economy_brands, ['Aczet', 'Labindia']);

  office.calls.length = 0;
  await engine.syncNow();
  const asked = office.calls.find((c) => c.path === '/products');
  assert.equal(asked.query.version, office.productsVersion, 'the phone says which version it holds');
  assert.equal(store.guideProducts.length, 2);
});

test('an edit by the manager replaces the guide, and a product the manager removed is gone', async () => {
  office.setProducts([balance, centrifuge]);
  const { store, engine } = await phone();
  await engine.syncNow();

  office.setProducts([{ ...balance, summary: 'A better text.' }]);
  await engine.syncNow();

  assert.equal(store.guideProducts.length, 1);
  assert.equal(store.productById(balance.uuid).summary, 'A better text.');
  assert.equal(store.productById(centrifuge.uuid), null);
});

test('the guide is kept (encrypted) when the app is locked and opened again', async () => {
  office.setProducts([balance]);
  const persist = new MemoryPersist();
  const first = await Store.open(persist, key);
  await first.saveProfile({ name: 'Rep', employeeCode: 'REP001' });
  await first.setGuideFromServer(cleanGuide({ version: 'abc', products: [balance] }));
  await first.close();

  const again = await Store.open(persist, key);
  assert.equal(again.guideProducts.length, 1);
  assert.equal(again.guideVersion, 'abc');

  const raw = JSON.stringify([...(await persist.keys('guide'))].map(String)) + (await persist.get('guide'));
  assert.ok(!raw.includes('Sartorius'), 'nothing readable on the disk');
});

test('an office without a guide (404) does not make the sync fail', async () => {
  const { store, engine } = await phone();
  const original = office.fetch;
  office.fetch = async (url, init) => (new URL(url).pathname.endsWith('/products') ? new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } }) : original(url, init));

  await engine.syncNow();
  assert.equal(store.syncState.last_error, null);
  assert.equal(store.guideProducts.length, 0);
});

test('hostile or broken products from the office are dropped or trimmed', () => {
  assert.equal(cleanProduct(null), null);
  assert.equal(cleanProduct({ uuid: 'not-a-uuid', name: 'X' }), null);
  assert.equal(cleanProduct({ uuid: uuid(1), name: 'A' }), null, 'a name of one letter is no name');

  const odd = cleanProduct({
    uuid: uuid(1), name: '  Balance  ', group: 5, sort: -4, premium_brands: ['Ok', 7, '', '  Sartorius '], variants: [{ name: 'n', text: '' }, { text: 'kept' }, 'text'],
    key_parameters: 'not a list', top_brands: [{ name: '', note: 'x' }, { name: 'Brand', note: 'y'.repeat(5000) }],
  });
  assert.equal(odd.name, 'Balance');
  assert.equal(odd.group, '');
  assert.equal(odd.sort, 0);
  assert.deepEqual(odd.premium_brands, ['Ok', 'Sartorius']);
  assert.deepEqual(odd.variants, [{ name: '', text: 'kept' }]);
  assert.deepEqual(odd.key_parameters, []);
  assert.equal(odd.top_brands.length, 1);
  assert.equal(odd.top_brands[0].note.length, 1000);

  assert.equal(cleanGuide({ products: [] }), null, 'no version, no guide');
  const guide = cleanGuide({ version: 'v', products: [balance, balance, { uuid: 'x' }, centrifuge] });
  assert.equal(guide.products.length, 2, 'a broken one and a repeated one are dropped');
});

// ---- search ----

const all = [cleanProduct(balance), cleanProduct(centrifuge), cleanProduct({
  uuid: uuid(47), name: 'Biosafety Cabinet', group: 'Safety cabinets and hoods', sort: 47, premium_brands: ['Kewaunee (Labindia)'], economy_brands: ['Tempo'], lite_brands: [],
  summary: 'Protects people and samples.', variants: [], key_parameters: [], short_term_problems: ['HEPA filter clogging.'], long_term_problems: [], top_brands: [],
})];

test('one search looks in names, brands, types and problems', () => {
  const names = (query, options) => searchProducts(all, query, options).map((r) => r.product.name);

  assert.deepEqual(names('balance'), ['Lab Weighing Balance']);
  assert.deepEqual(names('weigh bal'), ['Lab Weighing Balance'], 'every word must be found; a word may be the start of a word');
  assert.deepEqual(names('sartorius'), ['Lab Weighing Balance'], 'a brand finds its product');
  assert.deepEqual(names('labindia').sort(), ['Biosafety Cabinet', 'Lab Weighing Balance'], 'a brand in a tier of two products');
  assert.deepEqual(names('hepa'), ['Biosafety Cabinet'], 'a problem finds its product');
  assert.deepEqual(names('balance centrifuge'), [], 'words from two products match nothing');
  assert.equal(searchProducts(all, 'hepa')[0].found, 'Problem in the first year');
  assert.equal(searchProducts(all, 'balance')[0].found, null, 'a match in the name needs no explanation');
  assert.equal(names('').length, 3);
});

test('the budget and the family narrow the list', () => {
  const names = (options) => searchProducts(all, '', options).map((r) => r.product.name);

  assert.deepEqual(names({ tier: 'premium' }), ['Lab Weighing Balance', 'Biosafety Cabinet']);
  assert.deepEqual(names({ tier: 'lite' }), ['Micro Centrifuge']);
  assert.deepEqual(names({ group: 'Centrifuges' }), ['Micro Centrifuge']);
  assert.deepEqual(names({ group: 'Centrifuges', tier: 'premium' }), []);
  assert.deepEqual(groupsOf(all).map((g) => g.name), ['Centrifuges', 'Balances and weighing', 'Safety cabinets and hoods'], 'in the order of the sheet');
});

// ---- asking the manager for a note ----

test('a request for a note is checked, kept, and sent once', async () => {
  office.setProducts([balance]);
  const { store, engine } = await phone();
  await engine.syncNow();

  await assert.rejects(store.saveNote({ product_id: balance.uuid, body: 'hi' }), ValidationError, 'too short');
  await assert.rejects(store.saveNote({ product_id: uuid(999), body: 'Please add a brand' }), ValidationError, 'not a product of the guide');
  await assert.rejects(store.saveNote({ product_id: null, product_name: '<b>x</b>', body: 'Please add a brand' }), ValidationError, 'a typed product name follows the name rules');
  await assert.rejects(store.saveNote({ product_id: balance.uuid, body: 'x'.repeat(501) }), ValidationError);

  const note = await store.saveNote({ product_id: balance.uuid, body: '  Please add Mettler Toledo under Premium.  ' });
  assert.equal(note.product_name, 'Lab Weighing Balance');
  assert.equal(note.body, 'Please add Mettler Toledo under Premium.');
  assert.equal(store.unsyncedCount, 1);

  await engine.syncNow();
  assert.equal(store.unsyncedCount, 0);
  assert.equal(store.notes[0].synced, true);
  assert.equal(office.count('product_requests'), 1);

  await engine.syncNow();
  assert.equal(office.count('product_requests'), 1, 'the same request is never sent twice');
});

test('a request about a product that is not in the guide yet can be typed', async () => {
  const { store, engine } = await phone();

  await store.saveNote({ product_id: null, product_name: 'Muffle Furnace', body: 'Please add this product to the guide.' });
  await engine.syncNow();

  const sent = [...office.rows.product_requests.values()][0].data;
  assert.equal(sent.product_name, 'Muffle Furnace');
  assert.equal(sent.product_uuid, null);
});

test('only the last requests that were sent are remembered', async () => {
  const { store, engine } = await phone();

  for (let n = 0; n < 65; n++) {
    await store.saveNote({ product_id: null, product_name: 'Muffle Furnace', body: `Request number ${n}` });
    await engine.syncNow();
  }

  assert.ok(store.notes.length <= 61, `${store.notes.length} requests kept`);
});

test('switching to another rep erases the guide and the requests', async () => {
  office.setProducts([balance]);
  const { store, engine } = await phone();
  await engine.syncNow();
  await store.saveNote({ product_id: balance.uuid, body: 'Please add a brand' });

  await store.wipeEverything();
  assert.equal(store.guideProducts.length, 0);
  assert.equal(store.guideVersion, null);
  assert.equal(store.notes.length, 0);
});
