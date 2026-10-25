// The positions (job titles) offered in the dropdown before the phone has ever heard from the office. The office keeps the shared
// list (the same names plus whatever the team added) and sends it on every sync, so this is only the starting point.
export const PRESET_POSITIONS = [
  'Owner / Director', 'Purchase Manager', 'Procurement Head', 'Lab Head', 'Quality (QC) Head',
  'Production Head', 'Store Manager', 'Accounts', 'Other',
];

// one spelling for comparing two positions ("purchase  manager" = "Purchase Manager")
export const positionKey = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export const cleanPosition = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();
