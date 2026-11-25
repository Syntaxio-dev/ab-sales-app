// "Report a bug" (v1.19): a rep tells the office something went wrong. Only words the rep typed leave the phone (plus the app version);
// no screenshot (the app hides its screen on purpose) and never any client, expense or call data.
import * as rules from './rules.js';

export const MIN_BODY = 10;
export const MAX_BODY = 1000;

// Where it happened, so the person who fixes it knows where to look.
export const AREAS = [
  { value: 'expenses', label: 'Expenses' },
  { value: 'clients', label: 'Clients' },
  { value: 'prospects', label: 'Prospects' },
  { value: 'leads', label: 'Leads' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'guide', label: 'Guide' },
  { value: 'calls', label: 'Calls' },
  { value: 'sync', label: 'Sync / sign in' },
  { value: 'other', label: 'Something else' },
];
export const isArea = (v) => AREAS.some((a) => a.value === v);
export const areaLabel = (v) => AREAS.find((a) => a.value === v)?.label ?? '';

export const bugProblem = ({ area, body }) => rules.firstError(
  isArea(area) ? null : 'Pick where it happened.',
  rules.required(body, { min: MIN_BODY, max: MAX_BODY, label: 'What went wrong' }),
);
