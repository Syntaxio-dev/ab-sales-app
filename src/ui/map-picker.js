import { MAPS_JS_URL, MAPS_KEY, PLACES_URL } from '../config.js';
import { round6, validCoords } from '../core/geo.js';
import { searchPlaces } from '../sync/http.js';
import { h, icon } from './dom.js';
import { openPage, toast } from './kit.js';

// "Pick on the map": a Google map with a pin fixed in the middle; the rep moves the map until the pin is on the client's door, like choosing a
// delivery address. -> { lat, lng } or null. The pin must sit on a zoomed-in map (MIN_ZOOM) so it is a shop, not a town.
// Google Maps needs the internet and the build's key (config.js); without either, the paste box of the form still works.
// There is NO "use my current location" here on purpose (a rep in the office could pin every client there).

const MIN_ZOOM = 17;
const START_ZOOM_PLACE = 13;
const START_ZOOM_SPOT = 18;
const DEFAULT_CENTER = { lat: 26.9124, lng: 75.7873 }; // Jaipur

export const mapAvailable = () => Boolean(MAPS_KEY && MAPS_JS_URL);

let loading = null;

// Loads Google's script once. Rejects when it cannot be reached or the key is refused.
function loadGoogle() {
  if (globalThis.google?.maps?.Map) return Promise.resolve(globalThis.google.maps);

  loading ??= new Promise((resolve, reject) => {
    globalThis.__abMapsReady = () => resolve(globalThis.google.maps);
    globalThis.gm_authFailure = () => { loading = null; reject(new Error('KEY')); }; // Google calls this when the key is not allowed

    const script = document.createElement('script');
    script.src = `${MAPS_JS_URL}?key=${encodeURIComponent(MAPS_KEY)}&callback=__abMapsReady&v=weekly`;
    script.async = true;
    script.onerror = () => { loading = null; reject(new Error('NET')); };
    document.head.append(script);
  });

  return loading;
}

export function openMapPicker(app, { start = null, place = '' } = {}) {
  if (!mapAvailable()) {
    toast('The map is not set up in this version. Paste the numbers of the spot instead.');
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let map = null;
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
      page.close();
    };

    const input = h('input', { class: 'input', type: 'search', autocomplete: 'off', maxLength: 150, placeholder: 'Search the shop, college or address', 'aria-label': 'Search a place', enterKeyHint: 'search' });
    const searchBtn = h('button', { type: 'button', class: 'btn small-btn', 'aria-label': 'Search' }, icon('search', 18));
    const results = h('div', { class: 'mp-results', role: 'listbox', hidden: true });
    const mapBox = h('div', { class: 'mp-map', 'aria-label': 'Map' });
    const pin = h('div', { class: 'mp-pin', 'aria-hidden': 'true' }, icon('pin', 34));
    const zoomIn = h('button', { type: 'button', class: 'mp-zoom', 'aria-label': 'Zoom in' }, icon('plus', 20));
    const zoomOut = h('button', { type: 'button', class: 'mp-zoom', 'aria-label': 'Zoom out' }, icon('minus', 20));
    const view = h('button', { type: 'button', class: 'mp-zoom mp-view', 'aria-label': 'Satellite view', 'aria-pressed': 'false' }, 'Sat');
    const status = h('p', { class: 'muted small mp-status' });
    const confirm = h('button', { class: 'btn primary block' }, 'Use this location');

    const readCentre = () => {
      const c = map.getCenter();
      return { lat: round6(c.lat()), lng: round6(c.lng()) };
    };

    function draw() {
      if (!map) return;
      const c = readCentre();
      const close = map.getZoom() >= MIN_ZOOM;
      status.textContent = close
        ? `Pin at ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}. Move the map so the pin is on the exact door.`
        : 'Zoom in until you can see the building, then put the pin on the exact spot.';
      confirm.setAttribute('aria-disabled', String(!close));
      confirm.classList.toggle('is-off', !close);
    }

    async function search() {
      const text = input.value.trim();
      if (text.length < 3) return toast('Type at least 3 letters to search.');

      searchBtn.disabled = true;
      try {
        const found = await searchPlaces(text, { base: PLACES_URL, key: MAPS_KEY, near: map ? readCentre() : null });
        results.replaceChildren(...(found.length
          ? found.map((r) => h('button', {
            type: 'button', class: 'mp-result', role: 'option',
            onclick() {
              results.hidden = true;
              map.setCenter({ lat: r.lat, lng: r.lng });
              map.setZoom(START_ZOOM_SPOT);
            },
          }, icon('pin', 16), h('span', null, r.name)))
          : [h('p', { class: 'muted small mp-none' }, 'Nothing found. Try the area or the town name, then move the map.')]));
        results.hidden = false;
      } catch {
        toast('Could not search. Check the internet, or move the map by hand.');
      } finally {
        searchBtn.disabled = false;
      }
    }

    searchBtn.addEventListener('click', search);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void search();
      }
    });

    confirm.addEventListener('click', () => {
      if (!map) return;
      if (map.getZoom() < MIN_ZOOM) return toast('Zoom in more: put the pin on the exact door.');

      const spot = readCentre();
      if (!validCoords(spot.lat, spot.lng)) return toast('That is not a real place.');
      finish(spot);
    });

    const page = openPage({
      title: 'Pick the exact location',
      onClose: () => finish(null),
      body: h('div', { class: 'mp' },
        h('div', { class: 'mp-search' }, input, searchBtn),
        results,
        h('div', { class: 'mp-stage' }, mapBox, pin, h('div', { class: 'mp-zooms' }, zoomIn, zoomOut, view)),
        status,
        h('p', { class: 'muted small' }, 'The map needs the internet. Without it, paste the numbers of the spot from Google Maps instead.')),
      footer: confirm,
    });

    loadGoogle().then((maps) => {
      if (answered) return;

      const hasStart = start && validCoords(start.lat, start.lng);
      map = new maps.Map(mapBox, {
        center: hasStart ? { lat: start.lat, lng: start.lng } : DEFAULT_CENTER,
        zoom: hasStart ? START_ZOOM_SPOT : START_ZOOM_PLACE,
        disableDefaultUI: true,
        gestureHandling: 'greedy',
        clickableIcons: false,
        keyboardShortcuts: false,
        mapTypeId: 'roadmap',
      });
      map.addListener('idle', draw);
      map.addListener('zoom_changed', draw);
      zoomIn.addEventListener('click', () => map.setZoom(map.getZoom() + 1));
      zoomOut.addEventListener('click', () => map.setZoom(map.getZoom() - 1));
      view.addEventListener('click', () => {
        const sat = map.getMapTypeId() !== 'hybrid';
        map.setMapTypeId(sat ? 'hybrid' : 'roadmap');
        view.setAttribute('aria-pressed', String(sat));
      });
      draw();

      // no spot yet: start at the town the rep typed as the place
      if (!hasStart && place && place.trim().length >= 3) {
        searchPlaces(place, { base: PLACES_URL, key: MAPS_KEY }).then((found) => {
          if (found[0] && !answered) {
            map.setCenter({ lat: found[0].lat, lng: found[0].lng });
            map.setZoom(START_ZOOM_PLACE);
          }
        }).catch(() => {});
      }
    }).catch((error) => {
      if (answered) return;
      toast(error?.message === 'KEY'
        ? 'Google refused the map key. Tell the office; meanwhile paste the numbers of the spot.'
        : 'The map could not load. Check the internet, or paste the numbers of the spot.');
      finish(null);
    });
  });
}
