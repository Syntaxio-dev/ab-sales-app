import { h, icon } from './dom.js';
import { confirmDialog, toast } from './kit.js';

// Follow-up reminders on the phone (Leads). The rep is told in plain words what happens before Android asks for its permission.

export async function askRemindersOn(app) {
  const ok = await confirmDialog({
    title: 'Remind you of follow-ups?',
    text: 'Your phone shows a short notice at the time you set for a follow-up. The notice does not name the client. Android will ask for permission next.',
    yes: 'Continue',
    danger: false,
  });
  if (!ok) return null;

  const state = await app.enableReminders();
  toast(state === 'on' ? 'Reminders are on.' : 'Android did not allow notifications. You can allow them in the phone settings.');
  return state;
}

export async function askRemindersOff(app) {
  const ok = await confirmDialog({ title: 'Turn off reminders?', text: 'The phone stops reminding you. Your follow-ups stay in the Leads tab.', yes: 'Turn off', danger: false });
  if (!ok) return null;

  await app.disableReminders();
  return 'off';
}

// A card for the top of the Leads tab while the rep has not decided yet. Fills `box` (nothing when there is nothing to say).
export async function fillReminderPrompt(app, box) {
  const state = await app.reminderState();
  if (state !== 'unset' && state !== 'denied') return box.replaceChildren();

  box.replaceChildren(h('div', { class: 'card pad lead-prompt' },
    h('p', { class: 'muted small grow' }, state === 'denied'
      ? 'Notifications are blocked. Allow them in the phone settings (Apps, AB Sales, Notifications) to get reminders.'
      : 'Get a notice on your phone when a follow-up is due, so no lead is missed.'),
    state === 'unset' ? h('button', { class: 'btn primary small-btn', onclick: async () => { await askRemindersOn(app); await fillReminderPrompt(app, box); } }, icon('alarm', 16), 'Turn on') : null));
}
