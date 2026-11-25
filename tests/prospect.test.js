import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { areaLabel, bugProblem } from '../src/core/bug.js';
import * as pr from '../src/core/prospect.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanProspect, cleanProspectNote } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

const BASE = 'https://office.example/api/sales/v1';
let office;
let key;

async function phone({ code = 'REP001', persist = new MemoryPersist() } = {}) {
  const store = await Store.open(persist, key);
  if (!store.profile) await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '1.19', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine, persist };
}

const person = (extra = {}) => ({ name: 'Ayush Sharma', position: 'Purchase Manager', phone: '98765 43210', email: 'ayush@example.com', linkedin: '', ...extra });
const company = (extra = {}) => ({ name: 'Bagru Textiles', territory: 'Bagru', address: 'Plot 4, Industrial Area', source: 'google', notes: '', people: [person()], ...extra });

const refuses = async (work, pattern) => {
  await assert.rejects(work, (error) => error instanceof ValidationError && pattern.test(error.message));
};

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

// ---- the pure rules --------------------------------------------------------------------------------------------

test('a LinkedIn address is kept as a plain linkedin.com link and nothing else is accepted', () => {
  assert.equal(pr.cleanLinkedin('linkedin.com/in/ayush-sharma/'), 'https://linkedin.com/in/ayush-sharma');
  assert.equal(pr.cleanLinkedin('https://www.linkedin.com/in/ayush-sharma?utm_source=share&trk=x#top'), 'https://www.linkedin.com/in/ayush-sharma');
  assert.equal(pr.cleanLinkedin('https://in.linkedin.com/company/bagru-textiles'), 'https://in.linkedin.com/company/bagru-textiles');
  assert.equal(pr.cleanLinkedin('   '), '');

  for (const bad of ['http://www.linkedin.com/in/x', 'https://evil.com/linkedin.com/in/x', 'https://linkedin.com.evil.com/in/x', 'javascript:alert(1)',
    'https://www.linkedin.com/', 'https://user:pw@www.linkedin.com/in/x', 'https://www.linkedin.com:8080/in/x', 'https://www.linkedin.com/in/a b', 'https://www.linkedin.com/in/<x>']) {
    assert.equal(pr.cleanLinkedin(bad), null, bad);
  }
});

test('territories are one list: the same place typed two ways is one territory, busiest first', () => {
  const list = pr.territories([{ territory: 'Bagru' }, { territory: 'bagru ' }, { territory: 'Behror' }, { territory: 'BAGRU' }, { territory: '' }]);
  assert.deepEqual(list, [{ name: 'Bagru', count: 3 }, { name: 'Behror', count: 1 }]);
  assert.equal(pr.canonicalTerritory('  bagru', ['Bagru', 'Behror']), 'Bagru');
  assert.equal(pr.canonicalTerritory('Kukas', ['Bagru']), 'Kukas');
  assert.deepEqual(pr.cleanAreas(['Bagru', 'bagru', 'B', '12345', 'Behror ']), ['Bagru', 'Behror']);
  assert.ok(pr.territoryProblem('Bag<ru>'));
  assert.ok(pr.territoryProblem(''));
  assert.equal(pr.territoryProblem('Bagru'), null);
});

test('the newest call decides the status, and a closed prospect is no longer worth calling', () => {
  assert.equal(pr.statusOf([]).outcome, 'new');
  const notes = [
    { created_at: '2026-11-20T10:00:00.000Z', outcome: 'no_answer' },
    { created_at: '2026-11-22T10:00:00.000Z', outcome: 'interested' },
    { created_at: '2026-11-21T10:00:00.000Z', outcome: 'not_interested' },
  ];
  assert.equal(pr.statusOf(notes).outcome, 'interested');
  assert.equal(pr.isOpenProspect(pr.statusOf(notes)), true);
  assert.equal(pr.isOpenProspect(pr.statusOf([{ created_at: '2026-11-22T10:00:00.000Z', outcome: 'do_not_call' }])), false);
  assert.equal(pr.isOpenProspect(pr.statusOf([])), true);
});

test('the search finds a company by its name, territory, a person or a number', () => {
  const p = { name: 'Bagru Textiles', territory: 'Bagru', address: '', notes: '', people: [{ name: 'Ayush Sharma', position: '', email: '', phone: '+919876543210' }] };
  for (const q of ['textiles', 'BAGRU', 'ayush', '98765', '+91 98765 43210', '']) assert.equal(pr.matches(p, q), true, q);
  assert.equal(pr.matches(p, 'behror'), false);
  assert.equal(pr.matches(p, '99999'), false);
});

test('a call note needs a real outcome and a follow-up that is not in the past or too far ahead', () => {
  const soon = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(pr.noteProblem({ outcome: 'interested', remark: 'Wants a quote', next_followup_at: soon }), null);
  assert.ok(pr.noteProblem({ outcome: 'maybe', remark: '' }));
  assert.ok(pr.noteProblem({ outcome: 'interested', remark: 'x'.repeat(301) }));
  assert.ok(pr.noteProblem({ outcome: 'interested', remark: '', next_followup_at: new Date(Date.now() - 86_400_000).toISOString() }));
  assert.ok(pr.noteProblem({ outcome: 'interested', remark: '', next_followup_at: new Date(Date.now() + 3 * 365 * 86_400_000).toISOString() }));
});

// ---- the store ---------------------------------------------------------------------------------------------------

test('a prospect is saved with its people, in the clean spelling', async () => {
  const { store } = await phone();
  const saved = await store.saveProspect(company({ territory: '  bagru ', people: [person({ linkedin: 'linkedin.com/in/ayush-sharma?x=1', email: 'AYUSH@Example.com' })] }));

  assert.equal(saved.territory, 'bagru');
  assert.equal(saved.people[0].phone, '+919876543210');
  assert.equal(saved.people[0].linkedin, 'https://linkedin.com/in/ayush-sharma');
  assert.equal(saved.people[0].email, 'ayush@example.com');
  assert.equal(saved.created_by_code, 'REP001');
  assert.equal(store.prospects.length, 1);
  assert.equal(store.prospectStatus(saved.id).outcome, 'new');

  // a later prospect in the same territory takes the spelling the team already uses
  const second = await store.saveProspect(company({ name: 'Bagru Dyes', territory: 'BAGRU', people: [] }));
  assert.equal(second.territory, 'bagru');
});

test('the store refuses what does not belong: bad names, numbers, e-mail, LinkedIn, too many people', async () => {
  const { store } = await phone();

  await refuses(() => store.saveProspect(company({ name: '' })), /Company/);
  await refuses(() => store.saveProspect(company({ territory: '' })), /Territory/);
  await refuses(() => store.saveProspect(company({ territory: 'Bag<ru>' })), /Territory/);
  await refuses(() => store.saveProspect(company({ source: 'telepathy' })), /where you found/);
  await refuses(() => store.saveProspect(company({ people: [person({ name: 'Ayush 2' })] })), /name/);
  await refuses(() => store.saveProspect(company({ people: [person({ phone: '12345' })] })), /phone/i);
  await refuses(() => store.saveProspect(company({ people: [person({ email: 'nope' })] })), /e-mail/i);
  await refuses(() => store.saveProspect(company({ people: [person({ linkedin: 'https://evil.com/x' })] })), /LinkedIn/);
  await refuses(() => store.saveProspect(company({ people: [person(), person({ name: 'Second Person' })] })), /same number/);
  await refuses(() => store.saveProspect(company({ people: Array.from({ length: 11 }, (_, i) => person({ name: `Person Name ${'ab'.repeat(i + 1)}`.replace(/\d/g, ''), phone: '' })) })), /At most 10/);
  assert.equal(store.prospects.length, 0);
});

test('one company once per territory, and one number once in the whole pool (a client number too)', async () => {
  const { store } = await phone();
  await store.saveProspect(company());

  await refuses(() => store.saveProspect(company({ name: 'bagru textiles', territory: 'BAGRU', people: [] })), /already saved in/);
  await refuses(() => store.saveProspect(company({ name: 'Other Mills', people: [person({ name: 'Someone Else' })] })), /already saved under Ayush Sharma \(Bagru Textiles\)/);
  await store.saveProspect(company({ name: 'Bagru Textiles', territory: 'Behror', people: [] })); // the same name in another territory is another company

  await store.saveClient({ name: 'JK Cement', city: 'Jaipur', lat: 26.9124, lng: 75.7873, phone: '9123456780' });
  await refuses(() => store.saveProspect(company({ name: 'Third Mills', people: [person({ name: 'Rohit Verma', phone: '9123456780' })] })), /a client: JK Cement/);

  // editing a prospect does not collide with itself
  const mine = store.prospects.find((p) => p.name === 'Bagru Textiles' && p.territory === 'Bagru');
  await store.saveProspect({ ...company(), id: mine.id, notes: 'Called twice' });
  assert.equal(store.prospectById(mine.id).notes, 'Called twice');
});

test('a call note can be added by anyone, but the details stay with the rep who added the prospect', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const saved = await a.store.saveProspect(company());
  await a.engine.syncNow();
  await b.engine.syncNow();

  const theirs = b.store.prospectById(saved.id);
  assert.ok(theirs, 'the other rep sees the prospect');
  assert.equal(theirs.created_by_code, 'REP001');
  assert.equal(b.store.canEdit(theirs), false);
  await refuses(() => b.store.saveProspect({ ...company(), id: saved.id, notes: 'hijack' }), /Only the rep who added/);
  await refuses(() => b.store.deleteProspect(saved.id), /Only the rep who added/);

  await b.store.saveProspectNote({ prospect_id: saved.id, outcome: 'interested', remark: 'Wants a quote for a centrifuge' });
  assert.equal(b.store.prospectStatus(saved.id).outcome, 'interested');
  await b.engine.syncNow();
  await a.engine.syncNow();

  assert.equal(a.store.notesOf(saved.id).length, 1);
  assert.equal(a.store.notesOf(saved.id)[0].created_by_code, 'REP002', 'everybody can see who called');
  assert.equal(a.store.prospectStatus(saved.id).label, 'Interested');
});

test('a note needs a prospect that is on the phone and a valid outcome', async () => {
  const { store } = await phone();
  await refuses(() => store.saveProspectNote({ prospect_id: crypto.randomUUID(), outcome: 'interested' }), /not on the phone/);
  const saved = await store.saveProspect(company());
  await refuses(() => store.saveProspectNote({ prospect_id: saved.id, outcome: 'whatever' }), /what happened/);
});

test('deleting a prospect takes its calls with it and reaches the other rep', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  const saved = await a.store.saveProspect(company());
  await a.store.saveProspectNote({ prospect_id: saved.id, outcome: 'no_answer' });
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(b.store.notesOf(saved.id).length, 1);

  await a.store.deleteProspect(saved.id);
  assert.equal(a.store.prospects.length, 0);
  assert.equal(a.store.notesOf(saved.id).length, 0);
  await a.engine.syncNow();
  await b.engine.syncNow();

  assert.equal(b.store.prospects.length, 0);
  assert.equal(b.store.notesOf(saved.id).length, 0, 'the calls to a deleted prospect leave the other phone too');
});

test('everything comes back on a new phone, and the office copy is not wiped by a missing field', async () => {
  const a = await phone({ code: 'REP001' });
  const saved = await a.store.saveProspect(company({ people: [person({ linkedin: 'linkedin.com/in/ayush-sharma' })] }));
  await a.store.saveProspectNote({ prospect_id: saved.id, outcome: 'call_back', remark: 'After Diwali', next_followup_at: new Date(Date.now() + 5 * 86_400_000).toISOString() });
  await a.engine.syncNow();
  assert.equal(a.store.unsyncedCount, 0);

  const fresh = await phone({ code: 'REP001' });
  await fresh.engine.syncNow();
  const back = fresh.store.prospectById(saved.id);
  assert.equal(back.people[0].linkedin, 'https://linkedin.com/in/ayush-sharma');
  assert.equal(back.territory, 'Bagru');
  assert.equal(fresh.store.prospectStatus(saved.id).note.remark, 'After Diwali');
});

test('a prospect the office refuses is kept, with the reason, and is not sent again until it is edited', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  // both phones were offline: each saved the same company before seeing the other's
  const mineA = await a.store.saveProspect(company({ people: [] }));
  await b.store.saveProspect(company({ people: [] }));
  await b.engine.syncNow();
  await a.engine.syncNow();

  assert.equal(a.store.refused.length, 1);
  assert.equal(a.store.refused[0].id, mineA.id);
  assert.match(a.store.refused[0].message, /already saved in this territory/);
  assert.equal(a.store.dirty('prospect').length, 0, 'a refused record is not sent again');
  assert.equal(office.count('prospects'), 1);
});

test('what the office sends is cleaned: a person who breaks a rule is dropped, a bad LinkedIn link is emptied', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const clean = cleanProspect({
    uuid, name: 'Bagru Textiles', territory: 'Bagru', source: 'nonsense', updated_at: '2026-11-25T10:00:00.000Z', created_by_code: 'REP001', created_by_name: 'Rep',
    people: [
      { name: 'Ayush Sharma', phone: '9876543210', linkedin: 'https://evil.com/x', email: 'a@b.co' },
      { name: 'X', phone: '' },
      { name: 'Second Person', phone: '+919123456780', linkedin: 'https://www.linkedin.com/in/second' },
    ],
  });
  assert.equal(clean.source, null);
  assert.equal(clean.people.length, 2);
  assert.equal(clean.people[0].linkedin, '');
  assert.equal(clean.people[1].linkedin, 'https://www.linkedin.com/in/second');
  assert.equal(cleanProspect({ uuid: 'nope', name: 'A', territory: 'B' }), null);
  assert.equal(cleanProspect({ uuid, name: 'Bagru Textiles', territory: '', updated_at: '2026-11-25T10:00:00.000Z' }), null);

  assert.equal(cleanProspectNote({ uuid, prospect_uuid: uuid, outcome: 'zzz', created_at: '2026-11-25T10:00:00.000Z' }), null);
  assert.equal(cleanProspectNote({ uuid, prospect_uuid: uuid, outcome: 'interested', created_at: '2026-11-25T10:00:00.000Z', remark: 'ok' }).remark, 'ok');
});

test('an office that does not know prospects yet is never sent the keys when there is nothing to send', async () => {
  const a = await phone({ code: 'REP001' });
  await a.store.saveClient({ name: 'JK Cement', city: 'Jaipur', lat: 26.9124, lng: 75.7873 });
  await a.engine.syncNow();

  const push = office.calls.filter((c) => c.path === '/sync/push').at(-1);
  for (const wire of ['prospects', 'prospect_notes', 'bug_reports']) assert.ok(!(wire in push.body), wire);
  assert.ok(!('prospects' in (push.body.deleted ?? {})));
});

// ---- bug reports -------------------------------------------------------------------------------------------------

test('a bug report needs a place and a real description, and reaches the office once', async () => {
  const { store, engine } = await phone();

  assert.ok(bugProblem({ area: 'nowhere', body: 'The save button does nothing at all' }));
  assert.ok(bugProblem({ area: 'clients', body: 'too short' }));
  assert.equal(bugProblem({ area: 'clients', body: 'The save button does nothing' }), null);
  assert.equal(areaLabel('sync'), 'Sync / sign in');

  await refuses(() => store.saveBug({ area: 'clients', body: 'short' }), /at least 10/);
  await refuses(() => store.saveBug({ area: 'clients', body: 'x'.repeat(1001) }), /at most 1000/);

  const saved = await store.saveBug({ area: 'prospects', body: 'The territory list is empty after a sync', app_version: '1.19' });
  assert.equal(store.bugs.length, 1);
  assert.equal(store.unsyncedCount, 1);

  await engine.syncNow();
  assert.equal(store.unsyncedCount, 0);
  assert.equal(office.count('bug_reports'), 1);
  // only what the rep typed, the place and the app version leave the phone
  const sent = office.calls.find((c) => c.path === '/sync/push' && c.body.bug_reports?.length).body.bug_reports[0];
  assert.deepEqual(Object.keys(sent).sort(), ['app_version', 'area', 'body', 'updated_at', 'uuid']);
  assert.equal(sent.uuid, saved.id);

  await engine.syncNow();
  assert.equal(office.count('bug_reports'), 1, 'sending again does not make a second report');
});

test('a bug report written offline waits, and too many waiting reports are refused', async () => {
  const { store } = await phone();
  for (let i = 0; i < 20; i++) await store.saveBug({ area: 'other', body: `Something odd happened, number ${i}` });
  await refuses(() => store.saveBug({ area: 'other', body: 'One more odd thing happened' }), /Many reports are still waiting/);
});

test('bug reports are never pulled back and never export client data', async () => {
  const a = await phone({ code: 'REP001' });
  const b = await phone({ code: 'REP002' });
  await a.store.saveBug({ area: 'other', body: 'Something odd happened here' });
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(b.store.bugs.length, 0);
  assert.equal(JSON.stringify(a.store.exportAll()).includes('bug'), false);
});
