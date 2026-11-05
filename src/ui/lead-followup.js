import { LEAD_STATUSES, MAX_REMARK, closesTo, leadLabel, suggestedReminder } from '../core/lead.js';
import { itemsSummary } from '../core/enquiry.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { formatDayTime, fromLocalInput, initials, tenAmIn, toLocalInput } from './format.js';
import { restrict } from './inputs.js';
import { chipGroup, confirmDialog, field, openPage, toast, validate } from './kit.js';
import { dateTimeInput } from './pickers.js';
import { callButton } from './people.js';

// "Follow-up": the one place where a rep logs what happened on a lead (an enquiry): the status, what the client said (the remark) and
// the next reminder. Opened from the Leads tab and from the enquiry page. Everything is checked again by the store (saveLeadFollowup).

const TWO_YEARS = 2 * 365 * 86_400_000;

const inHours = (n) => new Date(Date.now() + n * 3_600_000);

export function openFollowup(app, id, { onSaved = null } = {}) {
  const store = app.store;
  const e = store.enquiryById(id);
  if (!e) return;

  const person = store.contactById(e.contact_id);
  const phone = person?.phone || store.clientById(e.client_id)?.phone;

  // what the rep has typed or picked so far
  const state = {
    status: null,                                      // always an explicit choice: a follow-up says where the lead stands NOW
    reminder: e.next_followup_at ? new Date(e.next_followup_at) : null,
    touched: false,                                    // the rep picked the reminder by hand: a status never moves it after that
    noReminder: false,
  };

  // ---- the status ------------------------------------------------------------------------------------------------------
  const statusSlot = (() => {
    const group = chipGroup(LEAD_STATUSES.map((s) => ({ value: s.value, label: s.label })), null, (value) => {
      state.status = value;
      if (!state.touched) state.reminder = suggestedReminder(value);
      state.noReminder = false;
      drawReminder();
    });
    return { group, ...field('Where does this lead stand now?', group.el) };
  })();

  // ---- the remark ------------------------------------------------------------------------------------------------------
  const remarkInput = restrict(h('textarea', {
    class: 'input', rows: 3, maxLength: MAX_REMARK, 'aria-label': 'Remark',
    placeholder: 'What did the client say? For example: will confirm on Friday, wants a better price',
  }), /[<>;]/g, { collapse: false });
  const counter = h('span', { class: 'muted small' }, `0 / ${MAX_REMARK}`);
  remarkInput.addEventListener('input', () => { counter.textContent = `${remarkInput.value.length} / ${MAX_REMARK}`; });
  const remarkSlot = field('Remark', remarkInput, null);

  // ---- the next reminder ------------------------------------------------------------------------------------------------
  const pick = dateTimeInput({ min: toLocalInput(new Date()), max: toLocalInput(new Date(Date.now() + TWO_YEARS - 86_400_000)), placeholder: 'Pick date and time', pickerTitle: 'Next reminder', 'aria-label': 'Next reminder' });
  pick.addEventListener('change', () => {
    const at = fromLocalInput(pick.value);
    if (!at) return;
    state.reminder = at;
    state.touched = true;
    state.noReminder = false;
    drawReminder();
  });

  const reminderLine = h('p', { class: 'lead-when' });
  const reminderChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Next reminder' });
  const reminderBox = h('div', { class: 'stack' });
  const reminderSlot = field('Next reminder', reminderBox, 'We remind you on your phone, so this lead is not forgotten.');

  function setReminder(at) {
    state.reminder = at;
    state.touched = true;
    state.noReminder = false;
    drawReminder();
  }

  function drawReminder() {
    const closing = closesTo(state.status);
    reminderSlot.el.hidden = Boolean(closing);
    if (closing) return;

    const same = (a, b) => a && b && Math.abs(a.getTime() - b.getTime()) < 60_000;
    const choices = [
      ['In 3 hours', inHours(3)],
      ['Tomorrow 10 am', tenAmIn(1)],
      ['In 3 days', tenAmIn(3)],
      ['Next week', tenAmIn(7)],
    ];
    reminderChips.replaceChildren(...choices.map(([label, at]) => h('button', {
      type: 'button', class: 'filter', 'aria-pressed': String(Boolean(same(state.reminder, at))), onclick: () => setReminder(at),
    }, label)));

    reminderLine.replaceChildren(
      icon('alarm', 16),
      state.noReminder ? ' No reminder: this lead will not remind you.' : state.reminder ? ` ${formatDayTime(state.reminder)}` : state.status ? ' Pick when to call next.' : ' Pick the status first.');
    reminderBox.replaceChildren(
      reminderLine,
      reminderChips,
      pick,
      h('button', { type: 'button', class: 'link', onclick: () => { state.noReminder = true; state.reminder = null; state.touched = true; drawReminder(); } }, 'No reminder'));
  }
  drawReminder();

  // ---- the top: who this is, and what was said last time -----------------------------------------------------------------
  const top = h('div', { class: 'card pad stack' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      h('span', { class: 'avatar' }, initials(e.client_name)),
      h('div', { class: 'grow', style: { minWidth: '0' } },
        h('h2', { style: { fontSize: '19px' } }, e.client_name),
        h('p', { class: 'muted small' }, [e.contact_name, itemsSummary(e.items, 2)].filter(Boolean).join(' · '))),
      phone ? callButton(phone) : null),
    e.lead_remark || e.last_followup_at
      ? h('div', { class: 'lead-last' },
        h('p', { class: 'eyebrow' }, 'Last time'),
        h('p', null, `${leadLabel(e.lead_status)}${e.lead_remark ? `: ${e.lead_remark}` : ''}`),
        e.last_followup_at ? h('p', { class: 'muted small' }, formatDayTime(new Date(e.last_followup_at))) : null)
      : null);

  // ---- save ----------------------------------------------------------------------------------------------------------
  let page = null;
  const save = h('button', { class: 'btn primary block', onclick: () => submit() }, 'Save follow-up');

  async function submit() {
    const closing = closesTo(state.status);
    const ok = validate([
      [statusSlot, state.status ? null : 'Pick where the lead stands.'],
      [reminderSlot, closing || state.noReminder || state.reminder ? null : 'Set the next reminder, or choose "No reminder".'],
    ]);
    if (!ok) return;

    if (closing && !(await confirmDialog({
      title: closing === 'won' ? 'Deal done?' : 'Deal lost?',
      text: 'This finishes the enquiry. It leaves the open leads and has no more reminders.',
      yes: closing === 'won' ? 'Yes, deal done' : 'Yes, deal lost',
      danger: closing === 'lost',
    }))) return;

    save.disabled = true;
    try {
      await store.saveLeadFollowup({
        id: e.id,
        lead_status: state.status,
        remark: remarkInput.value,
        next_followup_at: state.reminder ? state.reminder.toISOString() : null,
        no_reminder: state.noReminder,
      });
      toast(closing ? (closing === 'won' ? 'Deal done. Well done!' : 'Marked as deal lost.') : 'Follow-up saved.');
      page?.close();
      onSaved?.();
    } catch (error) {
      save.disabled = false;
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    }
  }

  page = openPage({
    title: 'Follow-up',
    body: h('div', { class: 'stack' }, top, statusSlot.el, remarkSlot.el, h('div', { style: { textAlign: 'right' } }, counter), reminderSlot.el),
    footer: save,
  });
}
