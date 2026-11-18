import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { allBrands, brandKey, brandNamed, brandProducts, brandTierCounts, brandTierLine, guideRivals, searchBrands, withBrandDefaults, withGuideDefaults } from '../src/core/guide.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store } from '../src/data/store.js';
import { aesKey, randomBytes, seal, toBase64, utf8 } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanBrand, cleanGuide } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

// The brand guide (v1.18): written by the manager, read on every phone; which products carry a brand comes from the product guide.

const BASE = 'https://office.example/api/sales/v1';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let office;
let key;

const product = (n, name, premium, economy, lite) => withGuideDefaults({
  id: uuid(n), uuid: uuid(n), name, group: 'G', sort: n, premium_brands: premium, economy_brands: economy, lite_brands: lite,
  summary: '', variants: [], industries: '', key_parameters: [], short_term_problems: [], long_term_problems: [], top_brands: [],
});
const products = [
  product(1, 'Magnetic Stirrer', ['Ika', 'Velp'], ['DLAB'], ['Remi']),
  product(2, 'Overhead Stirrer', ['Ika'], ['DLAB'], []),
  product(3, 'Lab Balance', ['Sartorius'], ['Aczet'], []),
  product(4, 'Vortex Mixer', ['Velp'], ['Ika'], ['Supertek']),
];

const ika = {
  uuid: uuid(101), name: 'Ika', origin: 'Germany · IKA-Werke', channel: 'Bishop', about: 'German mixing specialist.',
  known_for: ['Stirrers'], known_lines: ['RCT magnetic stirrers'], best_for: ['Chemistry labs'], pitch: ['Lasts for years'],
  objections: [{ if: 'Too costly', then: 'Compare the life.' }], watch_out: ['Premium price'],
  competitors: [{ name: 'Heidolph', note: 'German rival.' }], sort: 1,
};

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  key = await aesKey(randomBytes(32));
});

async function phone(persist = new MemoryPersist()) {
  const store = await Store.open(persist, key);
  await store.saveProfile({ name: 'Rep', employeeCode: 'REP001' });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '1.18', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: 'REP001', password: 'secret-pass-1' });
  return { store, engine, persist };
}

// ---- what the phone works out from the product guide ----

test('a brand name is matched however it is spelled', () => {
  assert.equal(brandKey('Cole-Parmer'), brandKey(' cole parmer '));
  assert.equal(brandNamed([withBrandDefaults({ id: 'x', name: 'Cole Parmer' })], 'cole-parmer').name, 'Cole Parmer');
  assert.equal(brandNamed([], 'Ika'), null);
});

test('the products of a brand, with their budget range, in the order of the sheet', () => {
  const rows = brandProducts(products, 'ika');
  assert.deepEqual(rows.map((r) => [r.product.name, r.tier.value]), [['Magnetic Stirrer', 'premium'], ['Overhead Stirrer', 'premium'], ['Vortex Mixer', 'economy']]);
  assert.deepEqual(brandTierCounts(products, 'Ika'), { premium: 2, economy: 1, lite: 0 });
  assert.equal(brandTierLine(products, 'Ika'), 'Premium and economy');
  assert.equal(brandTierLine(products, 'Remi'), 'Lite');
  assert.equal(brandTierLine(products, 'Nobody'), '');
});

test('our other brands in the same products, most shared first, with where they usually sit', () => {
  const rivals = guideRivals(products, 'Ika');
  assert.deepEqual(rivals.map((r) => r.name), ['DLAB', 'Velp', 'Remi', 'Supertek']);
  assert.equal(rivals[0].shared, 2);
  assert.equal(rivals[0].tierHint, 'economy');
  assert.ok(!rivals.some((r) => r.name === 'Sartorius'), 'a brand of another product is no rival');
});

test('every brand can be opened: the brand guide plus names only found in the product lists', () => {
  const rows = allBrands([withBrandDefaults({ id: 'b', name: 'Ika' }), withBrandDefaults({ id: 'c', name: 'Unused Brand' })], products);
  assert.equal(rows[0].name, 'Ika', 'the brand in the most products comes first');
  assert.equal(rows[0].count, 3);
  assert.ok(rows.find((r) => r.name === 'Unused Brand' && r.count === 0 && r.brand));
  assert.ok(rows.find((r) => r.name === 'Aczet' && r.brand === null));
  assert.equal(rows.filter((r) => brandKey(r.name) === 'ika').length, 1);
});

test('a brand search looks in the name first, then in what it is known for', () => {
  const brands = [withBrandDefaults({ id: 'a', name: 'Carbolite Gero', known_for: ['Furnaces'] }), withBrandDefaults({ id: 'b', name: 'Ika', known_for: ['Stirrers'] })];
  assert.deepEqual(searchBrands(brands, 'furn').map((b) => b.name), ['Carbolite Gero']);
  assert.deepEqual(searchBrands(brands, 'ika').map((b) => b.name), ['Ika']);
  assert.deepEqual(searchBrands(brands, ''), []);
  assert.deepEqual(searchBrands(brands, 'ika furnace'), [], 'every word must be found');
});

// ---- from the office to the phone ----

test('hostile or broken brands are dropped or trimmed', () => {
  assert.equal(cleanBrand(null), null);
  assert.equal(cleanBrand({ uuid: 'not-a-uuid', name: 'X' }), null);
  assert.equal(cleanBrand({ uuid: uuid(1), name: 'A' }), null, 'a name needs two letters');

  const b = cleanBrand({
    uuid: uuid(1), name: 'x'.repeat(300), about: 'a'.repeat(5000), pitch: Array(20).fill('p'), known_for: [1, null, ' ok '],
    objections: [{ if: 'q' }, { if: 'Too costly', then: 'Answer' }], competitors: [{ note: 'no name' }, { name: 'Rival' }], sort: -5,
  });
  assert.equal(b.name.length, 100);
  assert.equal(b.about.length, 1000);
  assert.equal(b.pitch.length, 6);
  assert.deepEqual(b.known_for, ['ok']);
  assert.deepEqual(b.objections, [{ if: 'Too costly', then: 'Answer' }]);
  assert.deepEqual(b.competitors, [{ name: 'Rival', note: '' }]);
  assert.equal(b.sort, 0);
  assert.deepEqual(b.known_lines, [], 'a missing list is an empty list');

  const guide = cleanGuide({ version: 'v1', products: [], brands: [ika, { ...ika, uuid: uuid(102), name: 'IKA' }, 'junk'] });
  assert.equal(guide.brands.length, 1, 'the same name twice is kept once');
  assert.deepEqual(cleanGuide({ version: 'v1', products: [] }).brands, [], 'an office older than 1.18 sends no brands');
});

test('the brands come to the phone with the guide and stay after a lock (encrypted)', async () => {
  office.setProducts([]);
  office.setBrands([ika]);
  const { store, engine, persist } = await phone();
  await engine.syncNow();

  assert.equal(store.guideBrands.length, 1);
  assert.equal(store.guideBrands[0].channel, 'Bishop');
  assert.deepEqual(store.guideBrands[0].objections, [{ if: 'Too costly', then: 'Compare the life.' }]);

  await store.close();
  const again = await Store.open(persist, key);
  assert.equal(again.guideBrands[0].name, 'Ika');
  const raw = String(await persist.get('guide'));
  assert.ok(!raw.includes('Bishop'), 'nothing readable on the disk');

  office.setBrands([{ ...ika, about: 'Changed by the manager.' }]);
  const second = await phone(persist);
  await second.engine.syncNow();
  assert.equal(second.store.guideBrands[0].about, 'Changed by the manager.');
});

test('a guide stored by an older app (no brands) is fetched again once, even when its stamp is the newest', async () => {
  office.setProducts([]);
  office.setBrands([ika]);

  // what v1.17 kept after the website got the brand guide: the office's newest stamp and no `brands` key at all
  const persist = new MemoryPersist();
  await persist.set('guide', toBase64(await seal(key, utf8(JSON.stringify({ version: office.productsVersion, products: [] })), 'guide')));

  const { store, engine } = await phone(persist);
  assert.equal(store.guideVersion, null, 'the old stamp is forgotten');
  assert.deepEqual(store.guideBrands, []);

  await engine.syncNow();
  assert.equal(store.guideBrands.length, 1, 'the brands arrive with the next sync');
  assert.equal(store.guideVersion, office.productsVersion);
});
