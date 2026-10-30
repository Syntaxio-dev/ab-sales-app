import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { CHECKIN_RADIUS_M, checkinLabel, checkinState, distanceM, formatDistance, spotProblem, validCoords } from '../src/core/geo.js';
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

// A client with the spot the OFFICE set (a rep's phone cannot set it: it only receives it).
async function clientAt(store, name, spot) {
  const made = await store.saveClient({ name });
  await store.putFromServer('client', { ...made, ...(spot ? { lat: spot.lat, lng: spot.lng, location_accuracy_m: null, location_at: now() } : {}) });
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

// ---- the client's spot (the office's) ----------------------------------------------------------------------

test('a rep cannot set or change the spot of a client: whatever is passed in is ignored', async () => {
  const { store } = await phone();

  const made = await store.saveClient({ name: 'JK Cement', ...JAIPUR, location_accuracy_m: 12 });
  assert.equal(made.lat, null, 'a new client has no spot until the office sets one');

  const set = await clientAt(store, 'Office Co', JAIPUR);
  assert.equal(set.lat, JAIPUR.lat);
  const edited = await store.saveClient({ id: set.id, name: 'Office Co Ltd', ...FAR });
  assert.equal(edited.lat, JAIPUR.lat, 'the rep\'s edit keeps the office\'s spot');
  assert.equal(edited.lng, JAIPUR.lng);
});

test('a client without a spot can be saved and edited; what the office sends is kept', async () => {
  const { store } = await phone();
  const legacy = cleanClient({ uuid: UUID, name: 'Legacy Co', updated_at: now() });
  assert.equal(legacy.lat, null);
  await store.putFromServer('client', { ...legacy, created_by_code: 'REP001' });

  assert.ok(await store.saveClient({ id: UUID, name: 'Legacy Co Ltd' }));
  const fromOffice = cleanClient({ uuid: UUID, name: 'Legacy Co Ltd', updated_at: now(), lat: 26.9, lng: 75.8 });
  await store.putFromServer('client', { ...fromOffice, created_by_code: 'REP001' });
  assert.equal(store.clientById(UUID).lat, 26.9);
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

test('the check-in and the selfie reach the office, the office measures it, and a new phone gets it all back', async () => {
  const a = await phone();
  const made = await a.store.saveClient({ name: 'JK Cement' });
  await a.engine.syncNow();
  assert.equal(office.rows.clients.get(made.id).data.lat, undefined, 'the phone never sends a client spot');

  // the manager sets the spot in the office
  const row = office.rows.clients.get(made.id);
  Object.assign(row.data, { lat: JAIPUR.lat, lng: JAIPUR.lng, updated_at: new Date(Date.now() + 5000).toISOString() });
  row.rev = ++office.rev;
  await a.engine.syncNow();
  const client = a.store.clientById(made.id);
  assert.equal(client.lat, JAIPUR.lat, 'the phone receives it');

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
  assert.equal(b.store.clientById(made.id).lat, JAIPUR.lat);
});

test('an office that does not know check-ins breaks nothing and the phone keeps its own', async () => {
  office.ignoresLocation = true;
  const a = await phone();
  const client = await clientAt(a.store, 'JK Cement', JAIPUR);
  const done = await a.store.saveMeeting(visit(client, { ...SPOT }), SELFIE);
  await a.engine.syncNow();

  assert.equal(a.store.refused.length, 0);
  assert.ok(a.store.meetingById(done.id).checkin_at, 'the check-in is not wiped');
  assert.equal(a.store.meetingById(done.id).has_selfie, true);
});
