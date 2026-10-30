import { checkinLabel, checkinState, formatDistance } from '../core/geo.js';
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

// The "Location" block of a client form. value = { lat, lng, accuracy_m, at } or null; the form calls problem() before saving.
export function locationField(app, { existing = null } = {}) {
  const has = existing && existing.lat !== null && existing.lat !== undefined;
  let spot = has ? { lat: existing.lat, lng: existing.lng, accuracy_m: existing.location_accuracy_m, at: existing.location_at } : null;
  let changed = false;

  const text = h('p', { class: 'muted small' });
  const button = h('button', { type: 'button', class: 'btn small-btn' });
  const box = h('div', null, h('p', { class: 'eyebrow' }, 'Location of the client'), text, button, h('p', { class: 'muted small' }, 'Stand at the client\'s shop or office when you save it. Your visits are checked against this spot.'));
  const field = slot(box, button);

  const draw = () => {
    text.textContent = spot
      ? `Saved${spot.accuracy_m ? `, accurate to about ${formatDistance(Math.round(spot.accuracy_m))}` : ''}.`
      : 'Not saved yet. This is required.';
    button.replaceChildren(icon('pin', 18), spot ? 'Update to my current location' : 'Use my current location');
  };

  button.addEventListener('click', async () => {
    const found = await readSpot(app, { why: 'This saves where the client is.' });
    if (!found) return;
    spot = { ...found, at: new Date().toISOString() };
    changed = true;
    field.setError(null);
    draw();
  });
  draw();

  return {
    ...field,
    // what to give store.saveClient: nothing when the spot was not touched (the old one stays)
    get fields() {
      return changed && spot ? { lat: spot.lat, lng: spot.lng, location_accuracy_m: spot.accuracy_m, location_at: spot.at } : {};
    },
    problem: () => (spot ? null : 'Save the client\'s location: tap "Use my current location" while you are at the client.'),
  };
}

// The chip that tells what a check-in proved.
export function checkinChip(meeting) {
  const state = checkinState(meeting);
  if (state === 'none') return null;
  return h('span', { class: `chip ${state === 'away' ? 'late' : state === 'verified' ? 'approved' : ''}` }, icon(state === 'away' ? 'alert' : 'pin', 12), checkinLabel(meeting));
}
