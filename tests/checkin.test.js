import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { CHECKIN_RADIUS_M, checkinLabel, checkinState, distanceM, firstUrl, formatDistance, parseSpot, spotProblem, validCoords } from '../src/core/geo.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanClient, cleanMeeting } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';
import { SELFIE, SPOT } from './helpers/checkin.js';

// The location of a client (required) and the check-in selfie of a visit: the rules, the sync and the old office.

const BASE = 'https://office.example/api/sales/v1';
const JAIPUR = { lat: 26.9124, lng: 75.7873 };
const NEAR = { lat: 26.9126, lng: 75.7875 }; // about 30 m
const FAR = { lat: 26.9324, lng: 75.7873 }; // about 2.2 km
const UUID = '11111111-1111-4111-8111-111111111111';

let office;
let key;

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

async function phone({ code = 'REP001', persist = new MemoryPersist() } = {}) {
  const store = await Store.open(persist, key);
  if (!store.profile) await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '1.8', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine };
}

const now = () => new Date().toISOString();

// A client with an exact spot. By default the rep gave it; { office: true } = the manager set it on the website.
async function clientAt(store, name, spot, { office = false } = {}) {
  const made = await store.saveClient(spot ? { name, city: 'Jaipur', ...spot } : { name, city: 'Jaipur', ...JAIPUR });
  if (office || !spot) {
    await store.putFromServer('client', { ...made, ...(spot ? { lat: spot.lat, lng: spot.lng, location_at: now(), location_source: 'office' } : { lat: null, lng: null, location_source: null }) });
  }
  return store.clientById(made.id);
}
const visit = (client, extra = {}) => ({ client_id: client.id, client_name: client.name, meeting_at: now(), status: 'done', ...extra });

// ---- the pure helpers ------------------------------------------------------------------------------

test('distance: zero for the same spot, about right for a known gap, and it formats', () => {
  assert.equal(distanceM(JAIPUR, JAIPUR), 0);
  const d = distanceM(JAIPUR, FAR);
  assert.ok(d > 2100 && d < 2300, String(d));
  assert.ok(distanceM(JAIPUR, NEAR) < CHECKIN_RADIUS_M);
  assert.equal(formatDistance(40), '40 m');
  assert.equal(formatDistance(2200), '2.2 km');
  assert.equal(formatDistance(null), '');
});

test('a spot must be a real place: ranges, numbers only, and 0,0 is a broken reader', () => {
  assert.ok(validCoords(26.9, 75.8));
  for (const [lat, lng] of [[91, 0], [0, 181], [NaN, 5], ['26.9', 75.8], [null, null], [0, 0], [undefined, 3]]) assert.equal(validCoords(lat, lng), false, `${lat},${lng}`);
  assert.equal(spotProblem(null) !== null, true);
  assert.equal(spotProblem({ ...JAIPUR, accuracy_m: 12 }), null);
  assert.notEqual(spotProblem({ ...JAIPUR, accuracy_m: -1 }), null);
});

test('check-in states: none, verified, away, and a client without a spot', () => {
  assert.equal(checkinState({ checkin_at: null }), 'none');
  assert.equal(checkinState({ checkin_at: now(), checkin_distance_m: 120 }), 'verified');
  assert.equal(checkinState({ checkin_at: now(), checkin_distance_m: 2200 }), 'away');
  assert.equal(checkinState({ checkin_at: now(), checkin_distance_m: null }), 'no_client_location');
  assert.match(checkinLabel({ checkin_at: now(), checkin_distance_m: 2200 }), /Away from client/);
});

// ---- the client's exact spot (required) ---------------------------------------------------------------------

test('Google Maps text becomes a spot: numbers or a long link, nothing else', () => {
  const want = { lat: 26.9124, lng: 75.7873 };
  assert.deepEqual(parseSpot('26.9124, 75.7873'), want);
  assert.deepEqual(parseSpot('  26.9124 75.7873 '), want);
  assert.deepEqual(parseSpot('https://www.google.com/maps/place/Jaipur/@26.9124,75.7873,17z/data=x'), want);
  assert.deepEqual(parseSpot('https://www.google.com/maps?q=26.9124,75.7873'), want);
  assert.deepEqual(parseSpot('https://maps.google.com/x/data=!3d26.9124!4d75.7873'), want);
  for (const bad of ['', 'hello', '120.5, 75.1', '0.000, 0.000', '26, 75', 'https://maps.app.goo.gl/abc123']) assert.equal(parseSpot(bad), null, bad);
});

test('a client needs a place and an exact spot; a made-up spot is refused', async () => {
  const { store } = await phone();

  await assert.rejects(store.saveClient({ name: 'JK Cement', city: 'Jaipur' }), /location/i);
  await assert.rejects(store.saveClient({ name: 'JK Cement', ...JAIPUR }), /Place/);
  await assert.rejects(store.saveClient({ name: 'JK Cement', city: 'Jaipur', lat: 120, lng: 75 }), ValidationError);
  await assert.rejects(store.saveClient({ name: 'JK Cement', city: 'Jaipur', lat: 0, lng: 0 }), ValidationError);
  assert.equal(store.clients.length, 0);

  const saved = await store.saveClient({ name: 'JK Cement', city: 'Jaipur', ...JAIPUR });
  assert.equal(saved.lat, JAIPUR.lat);
  assert.equal(saved.location_source, 'rep');
  assert.ok(saved.location_at);
});

test('an edit that says nothing keeps the spot; the rep can pin it again; the office\'s spot cannot be moved by a rep', async () => {
  const { store } = await phone();
  const c = await clientAt(store, 'JK Cement', JAIPUR);

  const renamed = await store.saveClient({ id: c.id, name: 'JK Cement Ltd' });
  assert.equal(renamed.lat, JAIPUR.lat);
  assert.equal(renamed.city, 'Jaipur', 'a place that is not mentioned stays');

  const moved = await store.saveClient({ id: c.id, name: 'JK Cement Ltd', ...FAR });
  assert.equal(moved.lat, FAR.lat, 'a spot the rep gave can be corrected by the rep');

  const set = await clientAt(store, 'Office Co', JAIPUR, { office: true });
  assert.equal(set.location_source, 'office');
  const edited = await store.saveClient({ id: set.id, name: 'Office Co Ltd', ...FAR });
  assert.equal(edited.lat, JAIPUR.lat, 'the manager\'s spot stays');
});

test('a client stored without a spot (an older record) asks for one when it is edited', async () => {
  const { store } = await phone();
  const legacy = cleanClient({ uuid: UUID, name: 'Legacy Co', city: 'Jaipur', updated_at: now() });
  assert.equal(legacy.lat, null);
  await store.putFromServer('client', { ...legacy, created_by_code: 'REP001' });

  await assert.rejects(store.saveClient({ id: UUID, name: 'Legacy Co Ltd' }), /location/i);
  assert.ok(await store.saveClient({ id: UUID, name: 'Legacy Co Ltd', ...JAIPUR }));
});

// ---- the check-in ------------------------------------------------------------------------------------------

test('a visit cannot be "done" without a check-in, but missed and moved need none', async () => {
  const { store } = await phone();
  const client = await clientAt(store, 'JK Cement', JAIPUR);

  await assert.rejects(store.saveMeeting(visit(client)), /Check in/);
  await assert.rejects(store.saveMeeting(visit(client, { ...SPOT })), /selfie/); // the spot without the picture
  assert.equal(store.meetings.length, 0);

  const missed = await store.saveMeeting(visit(client, { status: 'missed' }));
  assert.equal(missed.checkin_at, null);

  const done = await store.saveMeeting(visit(client, { ...SPOT, checkin: { ...NEAR, accuracy_m: 9 } }), SELFIE);
  assert.equal(done.has_selfie, true);
  assert.equal(done.selfie_synced, false);
  assert.ok(done.checkin_distance_m < CHECKIN_RADIUS_M);
  assert.equal(checkinState(done), 'verified');
  assert.ok(await store.selfieFor(done.id));
});

test('a check-in far from the client still saves, flagged as away; an unknown client spot gives none', async () => {
  const { store } = await phone();
  const client = await clientAt(store, 'JK Cement', JAIPUR);

  const away = await store.saveMeeting(visit(client, { checkin: { ...FAR, accuracy_m: 20 } }), SELFIE);
  assert.equal(checkinState(away), 'away');
  assert.ok(away.checkin_distance_m > CHECKIN_RADIUS_M);

  const typed = await store.saveMeeting(visit({ id: null, name: 'Walk-in Co' }, { client_id: null, checkin: { ...JAIPUR } }), SELFIE);
  assert.equal(checkinState(typed), 'no_client_location');
});

test('the check-in is checked: a bad spot, a future time, a file that is not a picture', async () => {
  const { store } = await phone();
  const client = await clientAt(store, 'JK Cement', JAIPUR);

  await assert.rejects(store.saveMeeting(visit(client, { checkin: { lat: 200, lng: 5 } }), SELFIE), ValidationError);
  await assert.rejects(store.saveMeeting(visit(client, { checkin: { ...JAIPUR, at: new Date(Date.now() + 3_600_000).toISOString() } }), SELFIE), /time/);
  await assert.rejects(store.saveMeeting(visit(client, { ...SPOT }), { selfie: new Uint8Array([1, 2, 3, 4]) }), /JPG/);
  assert.equal(store.meetings.length, 0);
});

test('a later edit keeps the check-in and a done visit can be corrected without a new selfie', async () => {
  const { store } = await phone();
  const client = await clientAt(store, 'JK Cement', JAIPUR);
  const done = await store.saveMeeting(visit(client, { ...SPOT }), SELFIE);

  const edited = await store.saveMeeting({ ...store.meetingById(done.id), id: done.id, discussion: 'Wants a quote' });
  assert.equal(edited.checkin_at, done.checkin_at);
  assert.equal(edited.has_selfie, true);
});

test('a planned visit becomes done only with a check-in', async () => {
  const { store } = await phone();
  const client = await clientAt(store, 'JK Cement', JAIPUR);
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const planned = await store.saveMeeting({ client_id: client.id, client_name: client.name, meeting_at: at, scheduled_at: at, status: 'planned' });

  await assert.rejects(store.saveMeeting({ ...store.meetingById(planned.id), id: planned.id, status: 'done', meeting_at: now() }), /Check in/);
  assert.equal((await store.saveMeeting({ ...store.meetingById(planned.id), id: planned.id, status: 'done', meeting_at: now(), ...SPOT }, SELFIE)).status, 'done');
});

test('deleting the meeting deletes the selfie, and wiping the phone does too', async () => {
  const persist = new MemoryPersist();
  const { store } = await phone({ persist });
  const client = await clientAt(store, 'JK Cement', JAIPUR);
  const done = await store.saveMeeting(visit(client, { ...SPOT }), SELFIE);
  assert.equal(await store.hasSelfieData(done.id), true);

  await store.deleteMeeting(done.id);
  assert.equal(await store.hasSelfieData(done.id), false);
});

// ---- what the office sends back ---------------------------------------------------------------------------

test('what the office sends for a spot is checked; a missing one is none', () => {
  assert.equal(cleanClient({ uuid: UUID, name: 'Co', updated_at: now(), lat: 26.9, lng: 75.8, location_accuracy_m: 9 }).lat, 26.9);
  assert.equal(cleanClient({ uuid: UUID, name: 'Co', updated_at: now(), lat: 999, lng: 75.8 }).lat, null);
  assert.equal(cleanClient({ uuid: UUID, name: 'Co', updated_at: now(), lat: 26.9 }).lng, null);

  const base = { uuid: UUID, client_name: 'Co', meeting_at: now(), updated_at: now() };
  assert.equal(cleanMeeting(base).checkin_at, null);
  assert.equal(cleanMeeting({ ...base, checkin_at: now(), checkin_lat: 99999, checkin_lng: 1 }).checkin_at, null);
  const m = cleanMeeting({ ...base, checkin_at: now(), checkin_lat: 26.9, checkin_lng: 75.8, checkin_distance_m: 120, has_selfie: true });
  assert.equal(m.checkin_distance_m, 120);
  assert.equal(m.has_selfie, true);
});

// ---- sync ---------------------------------------------------------------------------------------------------------

test('the spot and the check-in reach the office, the office measures it, and a new phone gets it all back', async () => {
  const a = await phone();
  const client = await clientAt(a.store, 'JK Cement', JAIPUR);
  await a.engine.syncNow();
  assert.equal(office.rows.clients.get(client.id).data.lat, JAIPUR.lat, 'the spot the rep gave is sent');

  const done = await a.store.saveMeeting(visit(client, { checkin: { ...FAR, accuracy_m: 15 } }), SELFIE);
  await a.engine.syncNow();

  assert.equal(office.rows.meetings.get(done.id).data.checkin_lat, FAR.lat);
  assert.ok(office.selfies.has(done.id), 'the selfie was uploaded');
  assert.equal(a.store.meetingById(done.id).selfie_synced, true);

  const b = await phone({ persist: new MemoryPersist() });
  await b.engine.syncNow();
  const back = b.store.meetingById(done.id);
  assert.equal(checkinState(back), 'away'); // the office worked the distance out itself
  assert.equal(back.has_selfie, true);
  assert.ok(await b.store.hasSelfieData(done.id));
  assert.equal(b.store.clientById(client.id).lat, JAIPUR.lat);
});

test('a spot the manager corrected on the website reaches the phone and stays the office\'s', async () => {
  const a = await phone();
  const client = await clientAt(a.store, 'JK Cement', JAIPUR);
  await a.engine.syncNow();

  const row = office.rows.clients.get(client.id);
  Object.assign(row.data, { lat: FAR.lat, lng: FAR.lng, location_source: 'office', updated_at: new Date(Date.now() + 5000).toISOString() });
  row.rev = ++office.rev;
  await a.engine.syncNow();

  const now2 = a.store.clientById(client.id);
  assert.equal(now2.lat, FAR.lat);
  assert.equal(now2.location_source, 'office');
  const tried = await a.store.saveClient({ id: client.id, name: 'JK Cement', ...JAIPUR });
  assert.equal(tried.lat, FAR.lat, 'the rep cannot move it back');
});

test('an office that does not know exact locations breaks nothing and the phone keeps its own', async () => {
  office.ignoresLocation = true;
  const a = await phone();
  const client = await clientAt(a.store, 'JK Cement', JAIPUR);
  const done = await a.store.saveMeeting(visit(client, { ...SPOT }), SELFIE);
  await a.engine.syncNow();

  assert.equal(a.store.refused.length, 0);
  assert.equal(a.store.clientById(client.id).lat, JAIPUR.lat, 'the answer without a spot does not wipe it');
  assert.ok(a.store.meetingById(done.id).checkin_at);
  assert.equal(a.store.meetingById(done.id).has_selfie, true);
});

test('a long link gives the exact place, not the middle of the screen; a shared text gives its link', () => {
  const long = 'https://www.google.com/maps/place/Agarwal+Brothers/@26.9100,75.7800,17z/data=!3m1!4b1!8m2!3d26.9124!4d75.7873';
  assert.deepEqual(parseSpot(long), { lat: 26.9124, lng: 75.7873 });
  assert.deepEqual(parseSpot('https://www.google.com/maps/@26.9100,75.7800,17z'), { lat: 26.91, lng: 75.78 });

  assert.equal(firstUrl('Agarwal Brothers\nSitapura, Jaipur\nhttps://maps.app.goo.gl/abc123.'), 'https://maps.app.goo.gl/abc123');
  assert.equal(firstUrl('no link here'), null);
  assert.equal(firstUrl('http://plain.example/x'), null, 'only https');
  assert.equal(parseSpot('https://maps.app.goo.gl/abc123'), null, 'a short link carries no numbers');
});

test('the phone asks the office to read a Google Maps link, and refuses what comes back wrong', async () => {
  const a = await phone();

  const found = await a.engine.resolveMapLink('Agarwal Brothers\nhttps://maps.app.goo.gl/ok123');
  assert.deepEqual(found, { lat: 26.9124, lng: 75.7873, name: 'Agarwal Brothers' });
  assert.equal(office.mapLinkAsked, 1);

  await assert.rejects(a.engine.resolveMapLink('https://maps.app.goo.gl/nothing'), /Could not find the place/);

  // an answer with a made-up place is not taken
  const real = office.resolveMapLink.bind(office);
  office.resolveMapLink = () => ({ ok: true, status: 200, json: async () => ({ lat: 999, lng: 5, name: 'x' }), text: async () => '{}' });
  await assert.rejects(a.engine.resolveMapLink('https://maps.app.goo.gl/ok123'), /No place/);
  office.resolveMapLink = real;
});
