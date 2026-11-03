import { SPOT_HELP, checkinLabel, checkinState, firstUrl, parseSpot } from '../core/geo.js';
import { h, icon } from './dom.js';
import { confirmDialog, slot, toast } from './kit.js';

// Where the rep is, read ONCE when a button is tapped (never in the background): the check-in selfie's spot.
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

export const LOCATION_STEPS = [
  'Fill in the client name and the place (town) above.',
  'Tap "Search on Google Maps". Google Maps opens with the name and place already typed.',
  'Pick the right shop or office from the list. Open it so you can see its page.',
  'Tap Share, then tap Copy link (or Copy).',
  'Come back to this app and tap "Paste the copied link". The exact location is filled in for you.',
];

// The exact location of a client, from Google Maps (required). Three ways in, all ending in two numbers:
//  1. "Search on Google Maps" opens the phone's Maps app with the client's name; the rep picks the right place and copies its link;
//  2. "Paste the copied link" (or pasting into the box) sends the link to the office, which opens it and reads the place;
//  3. typing / pasting the two numbers (or a long link) works with no office at all.
// There is NO "use my current location" on purpose (a rep standing in the office could set every client from there).
// A spot the manager has set on the website is the office's and shows read only. `fields` is what to give store.saveClient.
export function locationField(app, { existing = null, getName = () => '', getPlace = () => '' } = {}) {
  const locked = existing?.location_source === 'office' && existing.lat !== null && existing.lat !== undefined;
  let spot = existing && existing.lat !== null && existing.lat !== undefined ? { lat: existing.lat, lng: existing.lng } : null;
  let changed = false;

  const box = h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', maxLength: 1500, placeholder: 'Paste the link here, or 26.9124, 75.7873', 'aria-label': 'Location link or numbers from Google Maps', enterKeyHint: 'done' });
  const status = h('p', { class: 'loc-status', role: 'status' });
  const search = h('a', { class: 'btn small-btn block' }, icon('pin', 18), 'Search on Google Maps');
  const paste = h('button', { type: 'button', class: 'btn small-btn block' }, icon('clipboard', 18), 'Paste the copied link');
  const guide = h('div', { class: 'loc-guide' },
    h('p', { class: 'loc-guide-title' }, 'How to add the location'),
    h('ol', { class: 'loc-steps' }, ...LOCATION_STEPS.map((text) => h('li', null, text))),
    h('p', { class: 'loc-guide-note' }, SPOT_HELP));
  const field = slot(h('div', { class: 'stack' },
    h('p', { class: 'eyebrow' }, 'Exact location'),
    status,
    locked ? null : guide,
    locked ? null : search,
    locked ? null : paste,
    locked ? null : box), box);

  const say = (text, tone = '') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  const draw = () => {
    if (locked) return say(`Set by the office: ${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}. Only the office can change it.`, 'ok');
    say(spot ? `Saved: ${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}. Do the steps below again to change it.` : 'Not saved yet. This is required.', spot ? 'ok' : '');
  };

  // the Maps app opens with the client's name and place typed in (a "geo:" link: the phone's own app, no web address in this app)
  const refreshSearch = () => {
    const words = `${getName()} ${getPlace()}`.replace(/[^\p{L}\p{N} .,'&-]/gu, ' ').replace(/\s+/g, ' ').trim();
    search.href = `geo:0,0?q=${encodeURIComponent(words || 'shop')}`;
  };
  search.addEventListener('click', () => {
    refreshSearch();
    // the phone's Maps app takes the screen: do not lock this app while the rep looks for the shop (the form would be lost), until they are back
    app.suspendAutoLock = true;
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', back);
      setTimeout(() => { app.suspendAutoLock = false; }, 1500);
    };
    document.addEventListener('visibilitychange', back);
    setTimeout(() => { app.suspendAutoLock = false; }, 10 * 60_000); // never for ever
  });
  refreshSearch();

  const take = (found, name) => {
    spot = found;
    changed = true;
    field.setError(null);
    say(`Found${name ? ` "${name}"` : ''}: ${found.lat.toFixed(5)}, ${found.lng.toFixed(5)}. Check that this is the right place, then save.`, 'ok');
  };

  // numbers, or a long link, are read on the phone; any other link goes to the office, which opens it
  async function handle(text) {
    const value = String(text ?? '').trim();
    if (!value) return;

    const direct = parseSpot(value);
    if (direct) return take(direct, null);

    if (!firstUrl(value)) return say('These numbers or this link could not be read. Follow the steps above and paste the link you copied.', 'bad');

    if (!app.sync?.resolveMapLink) return say('This needs the internet and the office. Connect to the office, or paste the two numbers of the spot instead.', 'bad');

    say('Reading the place from the link...');
    try {
      const found = await app.sync.resolveMapLink(value);
      take({ lat: found.lat, lng: found.lng }, found.name);
    } catch (error) {
      say(error?.code === 'OFFLINE'
        ? 'Could not reach the office. Check the internet and try again, or paste the two numbers of the spot.'
        : 'Could not find the place in this link. Open the exact shop in Google Maps, tap Share, Copy link, and try again.', 'bad');
    }
  }

  box.addEventListener('change', () => handle(box.value));
  box.addEventListener('paste', () => setTimeout(() => handle(box.value), 50));

  paste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return say('Nothing was copied. In Google Maps tap Share, then Copy link, then come back here.', 'bad');
      box.value = text.slice(0, 1500);
      await handle(text);
    } catch {
      say('The phone did not allow reading what you copied. Press and hold in the box below, choose Paste, and the location is read.', 'bad');
      box.focus();
    }
  });

  draw();

  return {
    ...field,
    get fields() {
      return changed && spot && !locked ? { lat: spot.lat, lng: spot.lng, location_accuracy_m: null, location_at: new Date().toISOString() } : {};
    },
    problem: () => (spot ? null : 'Add the exact location of the client (follow the steps). It is required.'),
    refreshSearch,
  };
}

// The chip that tells what a check-in proved.
export function checkinChip(meeting) {
  const state = checkinState(meeting);
  if (state === 'none') return null;
  return h('span', { class: `chip ${state === 'away' ? 'late' : state === 'verified' ? 'approved' : ''}` }, icon(state === 'away' ? 'alert' : 'pin', 12), checkinLabel(meeting));
}
