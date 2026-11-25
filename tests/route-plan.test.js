import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { atTime } from '../src/core/meeting.js';
import { areaOf, fitsOneDay, plannedTimes, searchStops, stopFromClient, stopFromProspect, titleFor } from '../src/core/route-plan.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { FakeOffice } from './helpers/fake-office.js';

const BASE = 'https://office.example/api/sales/v1';
let office;
let key;

async function phone(code = 'REP001') {
  const store = await Store.open(new MemoryPersist(), key);
  await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '1.19', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine };
}

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

const client = (id, name, city, assigned = null) => ({ id, name, company: '', city, phone: '', assigned_to_code: assigned });
const prospect = (id, name, territory, extra = {}) => ({ id, name, territory, address: '', notes: '', people: [], ...extra });
const open = () => ({ outcome: 'new' });

// ---- the pure helpers ----------------------------------------------------------------------------------------------

test('with nothing typed the picker offers the clients the office gave and the open prospects in my territories', () => {
  const clients = [client('c1', 'JK Cement', 'Jaipur', 'REP001'), client('c2', 'Shree Cement', 'Beawar', 'REP002'), client('c3', 'Lab Co', 'Jaipur', 'REP001')];
  const prospects = [prospect('p1', 'Bagru Textiles', 'Bagru'), prospect('p2', 'Behror Mills', 'Behror'), prospect('p3', 'Closed Dyes', 'Bagru')];
  const status = (id) => (id === 'p3' ? { outcome: 'not_interested' } : open());

  const found = searchStops({ clients, prospects, status, me: 'REP001', areas: ['bagru'] }, '');
  assert.deepEqual(found.clients.map((c) => c.id), ['c1', 'c3'], 'only the clients given to me');
  assert.deepEqual(found.prospects.map((p) => p.id), ['p1'], 'my territory only, and not a closed prospect');

  const none = searchStops({ clients, prospects, status, me: 'REP009', areas: [] }, '');
  assert.equal(none.clients.length, 3, 'when nothing was given, every client on the phone');
  assert.equal(none.prospects.length, 2, 'no territory chosen: every open prospect');
});

test('typing finds clients AND prospects together, by name, place, company, a person or a number', () => {
  const clients = [client('c1', 'JK Cement', 'Jaipur'), { ...client('c2', 'Lab Co', 'Bagru'), phone: '+919876543210' }];
  const prospects = [prospect('p1', 'Bagru Textiles', 'Bagru', { people: [{ name: 'Ayush Sharma', position: '', email: '', phone: '+919123456780' }] }), prospect('p2', 'Dead Number Mills', 'Behror')];
  const status = (id) => (id === 'p2' ? { outcome: 'do_not_call' } : open());
  const ids = (list) => list.map((x) => x.id);
  const find = (text) => searchStops({ clients, prospects, status }, text);

  assert.deepEqual([ids(find('bagru').clients), ids(find('bagru').prospects)], [['c2'], ['p1']], 'a place matches both lists');
  assert.deepEqual(ids(find('ayush').prospects), ['p1'], 'a person of a prospect');
  assert.deepEqual(ids(find('98765').clients), ['c2'], 'a client number');
  assert.deepEqual(ids(find('91234').prospects), ['p1'], 'a prospect person number');
  assert.deepEqual(ids(find('mills').prospects), [], 'a "do not call" prospect is never offered');
  assert.deepEqual([find('zzz').clients.length, find('zzz').prospects.length], [0, 0]);
});

test('the stops are spaced 90 minutes apart and a route must stay inside one day', () => {
  const start = atTime(new Date(2026, 10, 30), '10:00');
  const times = plannedTimes(start, 3);
  assert.deepEqual(times.map((t) => `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`), ['10:00', '11:30', '13:00']);
  assert.equal(fitsOneDay(times), true);
  assert.equal(fitsOneDay(plannedTimes(atTime(new Date(2026, 10, 30), '20:00'), 4)), false, 'it would pass midnight');
  assert.equal(fitsOneDay([]), true);
});

test('the route takes the place most of its stops are in, and its name from it', () => {
  const stops = [stopFromProspect(prospect('p1', 'A Mills', 'Bagru')), stopFromClient(client('c1', 'B Lab', 'Jaipur')), stopFromProspect(prospect('p2', 'C Dyes', 'bagru'))];
  assert.equal(areaOf(stops), 'Bagru');
  assert.equal(titleFor(stops), 'Bagru run');
  assert.equal(titleFor([]), 'Route');
  assert.deepEqual(stops.map((s) => s.kind), ['prospect', 'client', 'prospect']);
  assert.equal(stops[0].key, 'prospect:p1');
});

// ---- a route of clients and prospects, saved and synced ---------------------------------------------------------------------

test('a route with a client and a prospect keeps who each stop is, and a second phone gets the same', async () => {
  const a = await phone('REP001');
  const c = await a.store.saveClient({ name: 'JK Cement', city: 'Jaipur', lat: 26.9124, lng: 75.7873 });
  const p = await a.store.saveProspect({ name: 'Bagru Textiles', territory: 'Bagru', people: [] });

  const start = atTime(new Date(Date.now() + 86_400_000), '10:00');
  const times = plannedTimes(start, 2);
  const m1 = await a.store.saveMeeting({ client_id: c.id, client_name: c.name, meeting_at: times[0].toISOString(), scheduled_at: times[0].toISOString(), status: 'planned', purpose: 'Demo', contact_ids: [] });
  const m2 = await a.store.saveMeeting({ client_id: null, prospect_id: p.id, client_name: p.name, meeting_at: times[1].toISOString(), scheduled_at: times[1].toISOString(), status: 'planned', purpose: 'Demo', contact_ids: [] });
  const route = await a.store.saveRoute({ title: 'Bagru run', area: 'Bagru', stops_order: [m1.id, m2.id], start_time: '10:00' });

  assert.equal(a.store.meetingById(m1.id).prospect_id, null);
  assert.equal(a.store.meetingById(m2.id).prospect_id, p.id);
  assert.equal(a.store.meetingById(m2.id).route_id, route.id);

  // an edit that says nothing about the prospect keeps it (the visit page saves the meeting again)
  await a.store.saveMeeting({ id: m2.id, client_id: null, client_name: p.name, meeting_at: times[1].toISOString(), purpose: 'Price talk', contact_ids: [] });
  assert.equal(a.store.meetingById(m2.id).prospect_id, p.id);

  await a.engine.syncNow();
  const sent = office.calls.filter((x) => x.path === '/sync/push').flatMap((x) => x.body.meetings ?? []);
  assert.equal(sent.find((x) => x.uuid === m2.id).prospect_uuid, p.id, 'the link to the prospect is sent');
  assert.equal('prospect_uuid' in sent.find((x) => x.uuid === m1.id), false, 'a client visit never carries the key');

  const b = await phone('REP001'); // signing in on a new phone signs the first one out, so it comes after the first sync
  await b.engine.syncNow();
  assert.equal(b.store.meetingById(m2.id).prospect_id, p.id, 'a new phone gets the link back');
  assert.equal(b.store.routes.length, 1);
  assert.deepEqual(b.store.routes[0].stops_order, [m1.id, m2.id]);
});
