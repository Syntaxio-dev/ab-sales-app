import { STATUSES, budgetTotal, isOpen, sourceLabel, statusLabel, urgency } from '../core/enquiry.js';
import { leadLabel } from '../core/lead.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { openEnquiryForm } from './enquiry-form.js';
import { formatDay, formatDayTime, formatTime, initials, rupees } from './format.js';
import { openFollowup } from './lead-followup.js';
import { confirmDialog, openPage, toast } from './kit.js';
import { callButton } from './people.js';

// Enquiries: what a client asked a rep for ("price of an oven and a furnace"), the follow-ups, and the notes until it is won or lost.
// One enquiry can ask for several products at once. The manager reads all of it on the website.

// A follow-up chip: "Overdue 25 Oct", "Today 4:30 pm", "27 Oct"
export function followupChip(enquiry, now = new Date()) {
  const state = urgency(enquiry, now);

  if (state === 'idle') return h('span', { class: 'chip late' }, 'No action for days');
  if (!enquiry.next_followup_at || !isOpen(enquiry.status)) return null;

  const at = new Date(enquiry.next_followup_at);
  if (state === 'overdue') return h('span', { class: 'chip late' }, icon('alarm', 12), `Overdue ${formatDay(at).replace(/ \d{4}$/, '')}`);
  if (state === 'today') return h('span', { class: 'chip today' }, icon('alarm', 12), `Today ${formatTime(at)}`);

  return h('span', { class: 'chip' }, icon('alarm', 12), formatDay(at).replace(/ \d{4}$/, ''));
}

export const statusChip = (status) => h('span', { class: `chip ${status === 'won' ? 'approved' : status === 'lost' ? 'lost' : ''}` }, statusLabel(status));

// ---- writing an enquiry: the three-step form lives in enquiry-form.js ---------------------------------------------

export { openEnquiryForm };

// ---- one enquiry ----------------------------------------------------------------------------------------------------

export function openEnquiryPage(app, id) {
  const store = app.store;
  const body = h('div', { class: 'stack' });
  let page = null;
  let stop = () => {};

  // the same enquiry with one thing changed (the store adds the note / status change to the timeline)
  const change = async (patch) => {
    const e = store.enquiryById(id);
    if (!e) return;

    try {
      await store.saveEnquiry({
        id: e.id, client_id: e.client_id, client_name: e.client_name, contact_id: e.contact_id, contact_name: e.contact_name, items: e.items,
        status: patch.status ?? e.status,
        source: e.source,
        next_followup_at: 'next_followup_at' in patch ? patch.next_followup_at : e.next_followup_at,
        note: patch.note ?? '',
      });
    } catch (error) {
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    }
  };

  const noteBox = h('textarea', { class: 'input', rows: 3, maxLength: 500, placeholder: 'What happened, what was said ...', 'aria-label': 'Note' });

  const draw = () => {
    const e = store.enquiryById(id);
    if (!e) {
      page?.close();
      return;
    }

    const now = new Date();
    const person = store.contactById(e.contact_id);
    const phone = person?.phone || store.clientById(e.client_id)?.phone;
    const budget = budgetTotal(e.items);
    const open = isOpen(e.status);

    body.replaceChildren(...[
      h('div', { class: 'card pad' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('span', { class: 'avatar' }, initials(e.client_name)),
          h('div', { class: 'grow', style: { minWidth: '0' } },
            h('h2', { style: { fontSize: '19px' } }, e.client_name),
            e.contact_name ? h('p', { class: 'muted' }, `${e.contact_name}${person?.position ? ` · ${person.position}` : ''}`) : null),
          phone ? callButton(phone) : null),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } }, statusChip(e.status), followupChip(e, now), e.source ? h('span', { class: 'chip' }, `via ${sourceLabel(e.source)}`) : null, h('span', { class: 'chip' }, `Opened ${formatDay(new Date(e.opened_at))}`))),

      h('div', null,
        h('div', { class: 'section-head', style: { marginBottom: '10px' } }, h('p', { class: 'eyebrow' }, `Asked for (${e.items.length})`), h('button', { class: 'link', onclick: () => openEnquiryForm(app, { existing: e }) }, 'Edit')),
        h('div', { class: 'list' }, e.items.map((i) => h('div', { class: 'item', style: { minHeight: '56px' } },
          h('span', { class: 'grow' },
            h('span', { class: 'title' }, `${i.product}${i.quantity > 1 ? ` x ${i.quantity}` : ''}`),
            h('span', { class: 'sub' }, [i.brands ? `Brands: ${i.brands}` : null, i.budget_paise ? `Budget ${rupees(i.budget_paise).replace(/\.00$/, '')}` : null].filter(Boolean).join(' · ') || 'No brand or budget noted'))))),
        budget ? h('p', { class: 'muted small', style: { marginTop: '8px' } }, `Total budget ${rupees(budget).replace(/\.00$/, '')}`) : null),

      h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Where it stands'),
        h('div', { class: 'chips' }, STATUSES.map((s) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(s.value === e.status), onclick: () => s.value !== e.status && change({ status: s.value }) }, s.label)))),

      h('div', { class: 'card pad stack' },
        h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Lead'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, h('span', { class: 'chip' }, leadLabel(e.lead_status)), followupChip(e, now)),
        e.lead_remark ? h('p', null, `"${e.lead_remark}"`) : h('p', { class: 'muted small' }, 'No remark yet.'),
        e.last_followup_at ? h('p', { class: 'muted small' }, `Last follow-up ${formatDayTime(new Date(e.last_followup_at))}`) : null,
        open ? h('button', { class: 'btn primary block small-btn', onclick: () => openFollowup(app, id) }, icon('phone', 16), 'Update follow-up') : null),

      h('div', { class: 'card pad stack' },
        h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Add a note'),
        noteBox,
        h('button', { class: 'btn primary block small-btn', onclick: async () => {
          if (!noteBox.value.trim()) return toast('Write the note first.');
          await change({ note: noteBox.value });
          noteBox.value = '';
        } }, 'Add note')),

      h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, 'Notes and status changes'),
        h('div', { class: 'list' }, [...e.timeline].reverse().map((t) => h('div', { class: 'item', style: { minHeight: '56px', cursor: 'default' } },
          h('span', { class: 'grow' },
            h('span', { class: 'title', style: { fontWeight: '600' } }, t.text || (t.status ? `Status: ${statusLabel(t.status)}` : '')),
            h('span', { class: 'sub' }, `${formatDayTime(new Date(t.at))}${t.status && t.text ? ` · ${statusLabel(t.status)}` : ''}`)))))),

      h('button', { class: 'btn danger block', onclick: async () => {
        if (await confirmDialog({ title: 'Delete this enquiry?', text: `The enquiry of ${e.client_name}, with its notes, is removed for good.` })) {
          await store.deleteEnquiry(id);
        }
      } }, icon('trash', 18), 'Delete enquiry'),
    ].filter(Boolean));
  };

  stop = store.subscribe(draw);
  draw();
  page = openPage({ title: 'Enquiry', body, onClose: () => stop() });
}
