import { checkinLabel, checkinState } from '../core/geo.js';
import { h, icon } from './dom.js';
import { confirmDialog, toast } from './kit.js';

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

// The chip that tells what a check-in proved.
export function checkinChip(meeting) {
  const state = checkinState(meeting);
  if (state === 'none') return null;
  return h('span', { class: `chip ${state === 'away' ? 'late' : state === 'verified' ? 'approved' : ''}` }, icon(state === 'away' ? 'alert' : 'pin', 12), checkinLabel(meeting));
}
