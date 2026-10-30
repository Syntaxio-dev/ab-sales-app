// Places on the map: a client's saved spot and the spot where a rep checked in with a selfie. Pure helpers, tested.
// Nothing here talks to the phone: the platform gives a spot, these functions only check it and compare two of them.

export const CHECKIN_RADIUS_M = 300; // further than this from the client = "away from client" (flagged for the manager, still saved)
export const MAX_ACCURACY_M = 100_000; // a larger error radius is not a real reading

const EARTH_M = 6_371_000;
const rad = (deg) => (deg * Math.PI) / 180;

export const isLat = (n) => typeof n === 'number' && Number.isFinite(n) && n >= -90 && n <= 90;
export const isLng = (n) => typeof n === 'number' && Number.isFinite(n) && n >= -180 && n <= 180;
export const validCoords = (lat, lng) => isLat(lat) && isLng(lng) && !(lat === 0 && lng === 0); // 0,0 is what a broken reader returns
export const isAccuracy = (n) => n === null || n === undefined || (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_ACCURACY_M);

// about 11 cm: more digits are noise
export const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Straight-line distance in metres (haversine).
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(x))));
}

// The error message for a spot, or null when it is fine. label is used in the message.
export function spotProblem(spot, { label = 'Location' } = {}) {
  if (!spot || !validCoords(spot.lat, spot.lng)) return `${label} is missing. Use "Use my current location" while you are at the place.`;
  if (!isAccuracy(spot.accuracy_m)) return `${label} could not be read properly. Please try again.`;
  return null;
}

export const hasLocation = (client) => Boolean(client) && validCoords(client.lat, client.lng);

// 'verified' = at the client's place, 'away' = further than the radius, 'no_client_location' = the client has no saved spot, 'none' = no check-in
export function checkinState(meeting) {
  if (!meeting?.checkin_at) return 'none';
  if (meeting.checkin_distance_m === null || meeting.checkin_distance_m === undefined) return 'no_client_location';
  return meeting.checkin_distance_m <= CHECKIN_RADIUS_M ? 'verified' : 'away';
}

export function formatDistance(metres) {
  if (metres === null || metres === undefined) return '';
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

// The short chip text for a check-in.
export function checkinLabel(meeting) {
  const state = checkinState(meeting);
  if (state === 'verified') return `Checked in · ${formatDistance(meeting.checkin_distance_m)} from client`;
  if (state === 'away') return `Away from client · ${formatDistance(meeting.checkin_distance_m)}`;
  if (state === 'no_client_location') return 'Checked in · client location missing';
  return 'No check-in';
}
