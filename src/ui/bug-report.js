import { AREAS, MAX_BODY, MIN_BODY, areaLabel, bugProblem } from '../core/bug.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { formatDayTime } from './format.js';
import { restrict } from './inputs.js';
import { chipGroup, field, openPage, toast, validate } from './kit.js';

// "Report a bug" (v1.19): a rep tells the office something went wrong. It works offline (the report waits and goes with the next sync).
// Only the words typed here, the place chosen and the app version leave the phone: no screenshot, no client, expense or call data.

const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export function openBugReport(app) {
  const store = app.store;
  let page = null;

  const area = chipGroup(AREAS.map((a) => ({ value: a.value, label: a.label })), null);
  const areaSlot = field('Where did it happen?', area.el);

  const body = restrict(h('textarea', {
    class: 'input', rows: 6, maxLength: MAX_BODY, 'aria-label': 'What went wrong',
    placeholder: 'What were you doing, and what happened instead? For example: I tapped Save on a new prospect and nothing happened.',
  }), /[<>]/g, { collapse: false });
  const counter = h('span', { class: 'muted small' }, `0 / ${MAX_BODY}`);
  body.addEventListener('input', () => { counter.textContent = `${body.value.length} / ${MAX_BODY}`; });
  const bodySlot = field('What went wrong?', body, `At least ${MIN_BODY} characters. Do not write passwords or your PIN.`);

  const recent = h('div', null);
  const drawRecent = () => {
    const bugs = store.bugs.slice(0, 5);
    recent.replaceChildren(...(bugs.length ? [
      h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Your last reports'),
      h('div', { class: 'list' }, bugs.map((b) => h('div', { class: 'item', style: { minHeight: '56px' } },
        h('span', { class: 'grow' },
          h('span', { class: 'title' }, areaLabel(b.area) || 'Report'),
          h('span', { class: 'sub' }, b.body.length > 90 ? `${b.body.slice(0, 90)}...` : b.body),
          h('span', { class: 'sub added' }, `${formatDayTime(new Date(b.created_at))} · ${b.sync_error ? 'The office could not take it' : b.synced ? 'Sent to the office' : 'Waiting to be sent'}`))))),
    ] : []));
  };
  drawRecent();
  const stop = store.subscribe(drawRecent);

  const save = h('button', { class: 'btn primary block' }, icon('alert', 18), 'Send report');
  save.addEventListener('click', async () => {
    const problem = bugProblem({ area: area.value, body: body.value });
    if (!validate([[areaSlot, area.value ? null : 'Pick where it happened.'], [bodySlot, area.value ? problem : null]])) return;

    save.disabled = true;
    try {
      await store.saveBug({ area: area.value, body: body.value, app_version: VERSION });
      toast(app.sync?.status?.connected ? 'Thank you. Your report is on its way to the office.' : 'Thank you. It will go to the office when you are connected.');
      page.close();
    } catch (error) {
      save.disabled = false;
      toast(error instanceof ValidationError ? error.message : 'Could not save the report. Please try again.');
    }
  });

  page = openPage({
    title: 'Report a bug',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Something not working, or looks wrong? Tell us here. Only what you write, the place you choose and the app version are sent. No screenshot and none of your clients, expenses or calls.'),
      areaSlot.el, bodySlot.el, h('div', { style: { textAlign: 'right' } }, counter), recent),
    footer: save,
    onClose: stop,
  });
}
