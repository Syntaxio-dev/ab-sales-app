import { SPOT_HELP, checkinLabel, checkinState, parseSpot } from '../core/geo.js';
import { h, icon } from './dom.js';
import { confirmDialog, slot, toast } from './kit.js';

// Where the rep is, read ONCE when a button is tapped (never in the background): the client's saved spot and the check-in selfie.
// Android's own permission dialog cannot be themed, so the app explains first in its own dialog.

const REASONS = {
  DENIED: 'Location permission was not given. Allow it for this app in the phone settings, then try again.',
  OFF: 'Switch on the phone\'s location (GPS) and try again.',
  TIMEOUT: 'Could not get a clear location. Step outside or near a window and try again.',
};

// -> { lat, lng, accuracy_m } or null (the person said no, or it failed: a message is shown)
export async function readSpot(app, { why }) {
  const ok = await confirmDialog({ title: 'Use your location?', text: `${why} The app reads your position once, now. It does not track you.`, yes: 'Continue', danger: false });
  if (!ok) return null;

  app.suspendAutoLock = true; // Android's permission dialog puts this app in the background
  try {
    return await app.platform.locate();
  } catch (error) {
    toast(REASONS[error?.code] ?? 'Could not read the location.');
    return null;
  } finally {
    app.suspendAutoLock = false;
  }
}

// -> Uint8Array of the selfie, or null. Front camera only: no gallery, so an old photo cannot be used.
export async function takeSelfie(app) {
  app.suspendAutoLock = true;
  try {
    return await app.platform.pickPhoto('selfie');
  } catch {
    toast('The camera could not be opened.');
    return null;
  } finally {
    app.suspendAutoLock = false;
  }
}

// The exact location of a client, from Google Maps (required). The rep pastes the numbers of the spot (or a long link); only the two numbers
// are kept. There is no "use my current location" here on purpose: a rep standing in the office could set every client from there.
// A spot the manager has set on the website is the office's and shows read only. value: what to give store.saveClient.
export function locationField(app, { existing = null } = {}) {
  const locked = existing?.location_source === 'office' && existing.lat !== null && existing.lat !== undefined;
  let spot = existing && existing.lat !== null && existing.lat !== undefined ? { lat: existing.lat, lng: existing.lng } : null;
  let changed = false;

  const box = h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', maxLength: 800, placeholder: 'For example 26.9124, 75.7873', 'aria-label': 'Exact location from Google Maps', enterKeyHint: 'done' });
  const status = h('p', { class: 'muted small' });
  const help = h('p', { class: 'muted small' }, SPOT_HELP);
  const field = slot(h('div', null, h('p', { class: 'eyebrow' }, 'Exact location (Google Maps)'), locked ? null : box, status, locked ? null : help), box);

  const draw = (message = null) => {
    status.textContent = locked
      ? `Set by the office: ${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}. Only the office can change it.`
      : message ?? (spot ? `Saved: ${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}. Paste another spot to change it.` : 'Not saved yet. This is required.');
  };

  box.addEventListener('input', () => {
    const found = parseSpot(box.value);
    field.setError(null);
    if (found) {
      spot = found;
      changed = true;
      draw(`Read: ${found.lat.toFixed(5)}, ${found.lng.toFixed(5)}`);
    } else {
      draw(box.value.trim() ? 'These numbers could not be read. Paste the two numbers of the spot, or a long Google Maps link.' : null);
    }
  });
  draw();

  return {
    ...field,
    get fields() {
      return changed && spot && !locked ? { lat: spot.lat, lng: spot.lng, location_accuracy_m: null, location_at: new Date().toISOString() } : {};
    },
    problem: () => (spot ? null : 'Paste the exact location of the client from Google Maps. It is required.'),
  };
}

// The chip that tells what a check-in proved.
export function checkinChip(meeting) {
  const state = checkinState(meeting);
  if (state === 'none') return null;
  return h('span', { class: `chip ${state === 'away' ? 'late' : state === 'verified' ? 'approved' : ''}` }, icon(state === 'away' ? 'alert' : 'pin', 12), checkinLabel(meeting));
}
