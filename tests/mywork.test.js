import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import * as work from '../src/core/mywork.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createHttp } from '../src/sync/http.js';
import { cleanMemo, cleanTask, cleanTodo } from '../src/sync/merge.js';
import { FakeOffice } from './helpers/fake-office.js';

const BASE = 'https://office.example/api/sales/v1';
let office;
let key;

async function phone(code = 'REP001') {
  const store = await Store.open(new MemoryPersist(), key);
  await store.saveProfile({ name: `Rep ${code}`, employeeCode: code });
  const http = createHttp({ base: BASE, fetchFn: (...args) => office.fetch(...args) });
  const engine = new SyncEngine({ store, http, appVersion: '1.20', deviceModel: 'Test phone', autoDelayMs: 15 });
  await engine.connect({ login: code, password: 'secret-pass-1' });
  return { store, engine };
}

beforeEach(async () => {
  office = new FakeOffice();
  office.addRep('REP001');
  office.addRep('REP002');
  key = await aesKey(randomBytes(32));
});

const refuses = (work_, pattern) => assert.rejects(work_, (e) => e instanceof ValidationError && pattern.test(e.message));
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ---- the pure rules ----------------------------------------------------------------------------------------------------------

test('a to-do needs words and a real date, and the list shows the soonest first with the done ones last', () => {
  assert.equal(work.todoProblem({ title: 'Call Greenlam', due_date: day(1) }), null);
  assert.ok(work.todoProblem({ title: 'x', due_date: null }));
  assert.ok(work.todoProblem({ title: 'a'.repeat(201), due_date: null }));
  assert.ok(work.todoProblem({ title: 'Call Greenlam', due_date: '26-11-2026' }));
  assert.ok(work.todoProblem({ title: 'Call Greenlam', due_date: day(900) }));

  const today = day(0);
  const list = [
    { id: 1, title: 'later', done: false, due_date: day(5), created_at: '2026-11-20T10:00:00Z' },
    { id: 2, title: 'no date', done: false, due_date: null, created_at: '2026-11-21T10:00:00Z' },
    { id: 3, title: 'late', done: false, due_date: day(-2), created_at: '2026-11-19T10:00:00Z' },
    { id: 4, title: 'finished', done: true, done_at: '2026-11-22T10:00:00Z', due_date: null, created_at: '2026-11-18T10:00:00Z' },
    { id: 5, title: 'today', done: false, due_date: today, created_at: '2026-11-22T10:00:00Z' },
  ];
  const sorted = work.sortTodos(list, today);
  assert.deepEqual(sorted.open.map((t) => t.id), [3, 5, 1, 2]);
  assert.deepEqual(sorted.done.map((t) => t.id), [4]);
  assert.deepEqual(sorted.late.map((t) => t.id), [3]);
  assert.deepEqual(sorted.today.map((t) => t.id), [5]);
});

test('a note needs a body; its title is optional and falls back to its first line', () => {
  assert.equal(work.memoProblem({ title: '', body: 'Prefers Sartorius' }), null);
  assert.ok(work.memoProblem({ title: '', body: '   ' }));
  assert.ok(work.memoProblem({ title: 'x'.repeat(121), body: 'ok' }));
  assert.equal(work.memoTitle({ title: 'Greenlam', body: 'x' }), 'Greenlam');
  assert.equal(work.memoTitle({ title: '', body: '\n  Prefers Sartorius\nCall after 11' }), 'Prefers Sartorius');
  assert.deepEqual(work.searchMemos([{ title: 'Greenlam', body: 'a' }, { title: '', body: 'Prefers Sartorius' }], 'sartorius').length, 1);
});

test('the rep may say Started, Done or Cannot do (with a reason) but never New or Cancelled, and not on a cancelled task', () => {
  const task = { status: 'new' };
  assert.equal(work.taskUpdateProblem({ status: 'in_progress', note: '' }, task), null);
  assert.equal(work.taskUpdateProblem({ status: 'done', note: 'Sent' }, task), null);
  assert.ok(work.taskUpdateProblem({ status: 'blocked', note: '  ' }, task), 'a reason is needed');
  assert.equal(work.taskUpdateProblem({ status: 'blocked', note: 'No specs' }, task), null);
  for (const bad of ['new', 'cancelled', 'whatever']) assert.ok(work.taskUpdateProblem({ status: bad, note: '' }, task), bad);
  assert.ok(work.taskUpdateProblem({ status: 'done', note: '' }, { status: 'cancelled' }));
  assert.ok(work.taskUpdateProblem({ status: 'done', note: 'x'.repeat(501) }, task));
});

test('open tasks come first (soonest date, high priority) and an overdue task is spotted', () => {
  const t = (id, extra) => ({ id, status: 'new', priority: 'normal', due_at: null, created_at: '2026-11-20T10:00:00Z', ...extra });
  const tasks = [t('a', { due_at: '2099-01-01T00:00:00Z' }), t('b', { due_at: '2000-01-01T00:00:00Z' }), t('c', { status: 'done', rep_updated_at: '2026-11-21T00:00:00Z' }), t('d', { priority: 'high' })];
  const { open, finished } = work.sortTasks(tasks);
  assert.deepEqual(open.map((x) => x.id), ['b', 'a', 'd']);
  assert.deepEqual(finished.map((x) => x.id), ['c']);
  assert.equal(work.isOverdue(tasks[1]), true);
  assert.equal(work.isOverdue(tasks[0]), false);
  assert.equal(work.isOverdue({ ...tasks[1], status: 'done' }), false, 'a finished task is never late');
  assert.equal(work.newTaskCount(tasks), 3);
});

test('only a plain e-mail address becomes a mail link, and a file name is made safe', () => {
  assert.equal(work.mailLink('buyer@greenlam.example', 'Quotation for Greenlam'), 'mailto:buyer@greenlam.example?subject=Quotation%20for%20Greenlam');
  for (const bad of ['', 'nope', 'a@b', 'x@y.com?bcc=evil@z.com', 'javascript:alert(1)', 'a b@c.com']) assert.equal(work.mailLink(bad), null, bad);
  assert.equal(work.fileLabel({ name: 'specs<b>.pdf' }), 'specsb.pdf');
  assert.equal(work.fileLabel({ name: '' }), 'file');
  assert.equal(work.sizeText(2048), '2 KB');
  assert.equal(work.sizeText(5 * 1_048_576), '5.0 MB');
});

// ---- the store ---------------------------------------------------------------------------------------------------------------------

test('to-dos and notes are saved, ticked, changed and deleted, and the store refuses what does not belong', async () => {
  const { store } = await phone();
  const t = await store.saveTodo({ title: '  Call   Greenlam ', due_date: day(1) });
  assert.equal(t.title, 'Call Greenlam');
  await refuses(() => store.saveTodo({ title: '' }), /To-do/);
  await refuses(() => store.saveTodo({ title: 'Call', due_date: 'tomorrow' }), /date/);

  const done = await store.setTodoDone(t.id, true);
  assert.equal(done.done, true);
  assert.ok(done.done_at);
  assert.equal((await store.setTodoDone(t.id, false)).done_at, null);

  const m = await store.saveMemo({ title: '', body: 'Prefers Sartorius' });
  await store.saveMemo({ id: m.id, title: 'Greenlam', body: 'Prefers Sartorius, call after 11' });
  assert.equal(store.memos.length, 1);
  assert.equal(store.memoById(m.id).title, 'Greenlam');
  await refuses(() => store.saveMemo({ title: '', body: '  ' }), /Note/);

  await store.deleteTodo(t.id);
  await store.deleteMemo(m.id);
  assert.equal(store.todos.length + store.memos.length, 0);
});

// ---- a task from the manager, through the sync ---------------------------------------------------------------------------------------

test('a task arrives with its files, the files are kept encrypted, and a status goes back to the office', async () => {
  const a = await phone('REP001');
  const uuid = office.giveTask('REP001', { title: 'Quotation for Greenlam', send_to_email: 'buyer@greenlam.example', files: [{ name: 'specs.pdf', mime: 'application/pdf', text: '%PDF-1.4 specs' }, { name: 'photo.jpg', mime: 'image/jpeg', text: 'jpeg-bytes' }] });
  await a.engine.syncNow();

  const task = a.store.taskById(uuid);
  assert.equal(task.title, 'Quotation for Greenlam');
  assert.equal(task.send_to_email, 'buyer@greenlam.example');
  assert.equal(task.status, 'new');
  assert.equal(task.files.length, 2);
  assert.equal(new TextDecoder().decode(await a.store.taskFileFor(uuid, task.files[0].id)), '%PDF-1.4 specs');
  assert.equal(work.newTaskCount(a.store.tasks), 1);

  await a.store.saveTaskUpdate({ id: uuid, status: 'in_progress', note: 'Working on it' });
  assert.equal(a.store.unsyncedCount, 1);
  await a.engine.syncNow();
  assert.equal(a.store.unsyncedCount, 0);
  assert.equal(office.rows.tasks.get(uuid).data.status, 'in_progress');
  assert.equal(office.rows.tasks.get(uuid).data.rep_note, 'Working on it');

  // only the status and the note went up: never the title or the e-mail
  const sent = office.calls.filter((c) => c.path === '/sync/push').flatMap((c) => c.body.tasks ?? []);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['rep_note', 'rep_updated_at', 'status', 'updated_at', 'uuid']);

  await a.store.saveTaskUpdate({ id: uuid, status: 'done', note: 'Sent to buyer@greenlam.example' });
  await a.engine.syncNow();
  assert.equal(office.rows.tasks.get(uuid).data.status, 'done');
  assert.equal(a.store.taskById(uuid).status, 'done');
});

test('a status the rep has not sent yet survives the office changing the task, and still goes up', async () => {
  const a = await phone('REP001');
  const uuid = office.giveTask('REP001', {});
  await a.engine.syncNow();

  office.offline = true;
  await a.store.saveTaskUpdate({ id: uuid, status: 'in_progress', note: 'Started offline' });
  office.offline = false;
  office.editTask(uuid, { title: 'Quotation for Greenlam (2 furnaces)', description: 'Changed by the manager' });

  // the first sync pulls the manager's change but keeps the rep's own unsent status
  await a.engine.syncNow();
  await a.engine.syncNow();
  const mine = a.store.taskById(uuid);
  assert.equal(mine.title, 'Quotation for Greenlam (2 furnaces)', 'the office\'s change is taken');
  assert.equal(mine.status, 'in_progress', 'the rep\'s status is not lost');
  assert.equal(office.rows.tasks.get(uuid).data.status, 'in_progress', 'and it reached the office');
  assert.equal(office.rows.tasks.get(uuid).data.rep_note, 'Started offline');
  assert.equal(a.store.unsyncedCount, 0);
});

test('a cancelled task cannot be changed any more, and the phone takes the office copy back', async () => {
  const a = await phone('REP001');
  const uuid = office.giveTask('REP001', { files: [{ name: 'specs.pdf', text: 'x' }] });
  await a.engine.syncNow();

  office.offline = true;
  await a.store.saveTaskUpdate({ id: uuid, status: 'done', note: 'Done' });
  office.offline = false;
  office.editTask(uuid, { status: 'cancelled' });
  await a.engine.syncNow();
  await a.engine.syncNow();

  assert.equal(a.store.taskById(uuid).status, 'cancelled');
  assert.equal(office.rows.tasks.get(uuid).data.status, 'cancelled', 'the manager\'s decision stands');
  assert.equal(a.store.unsyncedCount, 0);
  await refuses(() => a.store.saveTaskUpdate({ id: uuid, status: 'done', note: '' }), /cancelled/);
});

test('a rep sees only their own tasks, and a new phone gets tasks, to-dos and notes back', async () => {
  const a = await phone('REP001');
  const b = await phone('REP002');
  const mine = office.giveTask('REP001', { title: 'Mine', files: [{ name: 'a.pdf', text: 'pdf' }] });
  office.giveTask('REP002', { title: 'Theirs' });
  await a.store.saveTodo({ title: 'Call Greenlam about the specs', due_date: day(1) });
  await a.store.saveMemo({ title: 'Greenlam', body: 'Prefers Sartorius' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  assert.deepEqual(a.store.tasks.map((t) => t.title), ['Mine']);
  assert.deepEqual(b.store.tasks.map((t) => t.title), ['Theirs']);
  assert.equal(b.store.todos.length + b.store.memos.length, 0, 'to-dos and notes are private');

  const fresh = await phone('REP001'); // a new phone (the first one is signed out)
  await fresh.engine.syncNow();
  assert.equal(fresh.store.taskById(mine).title, 'Mine');
  assert.equal(new TextDecoder().decode(await fresh.store.taskFileFor(mine, fresh.store.taskById(mine).files[0].id)), 'pdf');
  assert.equal(fresh.store.todos[0].title, 'Call Greenlam about the specs');
  assert.equal(fresh.store.memos[0].body, 'Prefers Sartorius');
});

test('what the office sends is cleaned: a bad e-mail is dropped, files are listed safely, a wrong status is "new"', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const clean = cleanTask({
    uuid, title: 'Quotation', description: 'Specs', send_to_email: 'x@y.com?bcc=evil@z.com', priority: 'urgent', status: 'sleeping', version: 3, created_at: '2026-11-26T10:00:00.000Z',
    files: [{ id: '7', name: 'specs.pdf', mime: 'application/pdf', size: 100 }, { id: 'abc', name: 'bad id.pdf', size: 1 }, { id: '8', name: '', size: 1 }, { id: 9, name: 'n.xlsx', mime: '', size: 99_999_999 }],
  });
  assert.equal(clean.send_to_email, '');
  assert.equal(clean.priority, 'normal');
  assert.equal(clean.status, 'new');
  assert.deepEqual(clean.files.map((f) => f.id), ['7', '9'], 'a file needs a numeric id and a name');
  assert.equal(clean.files[1].size, 0, 'an impossible size is dropped');
  assert.equal(cleanTask({ uuid: 'nope', title: 'x' }), null);
  assert.equal(cleanTask({ uuid, title: 'ab', created_at: 'garbage' }), null);

  assert.equal(cleanTodo({ uuid, title: 'a', updated_at: '2026-11-26T10:00:00.000Z' }), null);
  assert.equal(cleanTodo({ uuid, title: 'Call Greenlam', done: true, done_at: '2026-11-26T11:00:00.000Z', due_date: '2026-11-30', updated_at: '2026-11-26T10:00:00.000Z' }).done, true);
  assert.equal(cleanMemo({ uuid, title: '', body: '', updated_at: '2026-11-26T10:00:00.000Z' }), null);
});
