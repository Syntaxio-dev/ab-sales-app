import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { App } from '../src/app.js';
import { MAX_REMINDERS, REMINDER_BODY, REMINDER_TITLE, planKey, planReminders, reminderId } from '../src/core/reminders.js';
import { MemoryPersist } from '../src/data/persist.js';
import { MemorySecrets, Vault } from '../src/security/vault.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-05T09:00:00Z');
const at = (hours) => new Date(NOW + hours * HOUR).toISOString();
const lead = (id, extra = {}) => ({ id, client_name: 'JK Cement', status: 'qualification', next_followup_at: at(5), ...extra });

// ---- the plan --------------------------------------------------------------------------------------------------------

test('one reminder per open lead that has a reminder still ahead, soonest first, with a text that names nobody', () => {
  const plan = planReminders([
    lead('late', { next_followup_at: at(-2) }),                 // already past: nothing to ring
    lead('soon', { next_followup_at: at(1), client_name: 'Secret Pharma Ltd' }),
    lead('later', { next_followup_at: at(30) }),
    lead('won', { status: 'won', next_followup_at: at(4) }),    // finished
    lead('none', { next_followup_at: null }),
  ], NOW);

  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((r) => r.at), [NOW + HOUR, NOW + 30 * HOUR]);
  for (const r of plan) {
    assert.equal(r.title, REMINDER_TITLE);
    assert.equal(r.body, REMINDER_BODY);
    assert.ok(Number.isInteger(r.id) && r.id > 0 && r.id < 2_147_483_647);
  }
  assert.doesNotMatch(JSON.stringify(plan), /Secret|Pharma|JK Cement/, 'no client name in a notification');
});

test('ids are stable, the plan is capped, and a changed plan has a different key', () => {
  assert.equal(reminderId('7d1f2a3c-0000-4000-8000-000000000001'), reminderId('7d1f2a3c-0000-4000-8000-000000000001'));
  assert.notEqual(reminderId('a'), reminderId('b'));

  const many = Array.from({ length: MAX_REMINDERS + 25 }, (_, i) => lead(`id-${i}`, { next_followup_at: at(i + 1) }));
  const plan = planReminders(many, NOW);
  assert.equal(plan.length, MAX_REMINDERS);
  assert.equal(plan[0].at, NOW + HOUR, 'the soonest ones are kept');

  assert.equal(planKey(planReminders(many, NOW)), planKey(plan));
  assert.notEqual(planKey(planReminders(many.slice(1), NOW)), planKey(plan));
  assert.equal(planKey([]), '');
});

// ---- the app: permission, scheduling, switching off, erasing ---------------------------------------------------------------

function fakeReminders({ permission = 'prompt', allow = true } = {}) {
  const r = {
    available: true, permission, scheduled: [], requests: 0, cancels: 0,
    async permissionNow() { return r.permission; },
  };
  return {
    state: r,
    api: {
      available: true,
      async permission() { return r.permission; },
      async request() { r.requests += 1; if (r.permission === 'prompt') r.permission = allow ? 'granted' : 'denied'; return r.permission === 'granted' ? 'granted' : 'denied'; },
      async schedule(list) { r.scheduled = list; },
      async cancelAll() { r.cancels += 1; r.scheduled = []; },
      onTap() {},
    },
  };
}

async function unlockedApp(reminders, clock = () => NOW) {
  const vault = new Vault(new MemorySecrets(), { iterations: 1000 });
  const app = new App({ vault, persist: new MemoryPersist(), platform: { cleanExports: async () => {}, reminders }, clock });
  await app.init();
  await app.setUp({ name: 'Rep One', employeeCode: 'REP001', pin: '483920' });
  return app;
}

const wait = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));

test('nothing is scheduled, and nothing asked, until the rep turns reminders on', async () => {
  const f = fakeReminders();
  const app = await unlockedApp(f.api);
  await app.store.saveEnquiry({ client_name: 'JK Cement', status: 'qualification', items: [{ product: 'Muffle Furnace', quantity: 1 }], next_followup_at: new Date(Date.now() + 3 * 86_400_000).toISOString() });
  await wait();

  assert.equal(await app.reminderState(), 'unset');
  assert.equal(f.state.requests, 0);
  assert.deepEqual(f.state.scheduled, []);
});

test('turning on asks Android once, then every lead reminder is scheduled and follows the leads', async () => {
  const f = fakeReminders();
  const app = await unlockedApp(f.api, () => Date.now());
  const day = 86_400_000;
  const a = await app.store.saveEnquiry({ client_name: 'JK Cement', status: 'qualification', items: [{ product: 'Muffle Furnace', quantity: 1 }], next_followup_at: new Date(Date.now() + 2 * day).toISOString() });

  assert.equal(await app.enableReminders(), 'on');
  assert.equal(f.state.requests, 1);
  assert.equal(await app.reminderState(), 'on');
  assert.equal(f.state.scheduled.length, 1);

  await app.store.saveEnquiry({ client_name: 'Other Lab', status: 'qualification', items: [{ product: 'Hot Air Oven', quantity: 1 }], next_followup_at: new Date(Date.now() + 4 * day).toISOString() });
  await wait();
  assert.equal(f.state.scheduled.length, 2, 'a new lead is reminded too');

  await app.store.saveLeadFollowup({ id: a.id, lead_status: 'deal_done', remark: 'PO' });
  await wait();
  assert.equal(f.state.scheduled.length, 1, 'a finished lead stops reminding');
});

test('a "no" from Android is remembered and nothing is scheduled; turning off cancels what is waiting', async () => {
  const refused = fakeReminders({ allow: false });
  const app1 = await unlockedApp(refused.api);
  assert.equal(await app1.enableReminders(), 'denied');
  assert.equal(await app1.reminderState(), 'off');
  assert.deepEqual(refused.state.scheduled, []);

  const f = fakeReminders();
  const app2 = await unlockedApp(f.api, () => Date.now());
  await app2.store.saveEnquiry({ client_name: 'JK Cement', status: 'qualification', items: [{ product: 'Muffle Furnace', quantity: 1 }], next_followup_at: new Date(Date.now() + 86_400_000).toISOString() });
  await app2.enableReminders();
  assert.equal(f.state.scheduled.length, 1);

  await app2.disableReminders();
  assert.equal(await app2.reminderState(), 'off');
  assert.deepEqual(f.state.scheduled, []);
});

test('erasing the phone cancels the reminders, and a browser (no reminders) is simply unavailable', async () => {
  const f = fakeReminders({ permission: 'granted' });
  const app = await unlockedApp(f.api, () => Date.now());
  await app.store.saveEnquiry({ client_name: 'JK Cement', status: 'qualification', items: [{ product: 'Muffle Furnace', quantity: 1 }], next_followup_at: new Date(Date.now() + 86_400_000).toISOString() });
  await app.enableReminders();
  assert.equal(f.state.scheduled.length, 1);

  await app.eraseEverything();
  assert.deepEqual(f.state.scheduled, []);
  assert.ok(f.state.cancels >= 1);

  const plain = await unlockedApp(undefined);
  assert.equal(await plain.reminderState(), 'unavailable');
  assert.equal(await plain.refreshReminders(), false);
});
