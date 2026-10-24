// Light / dark / follow the phone. The choice is not secret, so it is kept in localStorage (key "ab-theme").
// public/theme-init.js applies the same rule before the first paint; this module keeps it in sync afterwards.

const KEY = 'ab-theme';
const CHOICES = ['system', 'light', 'dark'];
const META_COLOR = { light: '#0B2545', dark: '#000000' };

export function getChoice() {
  try {
    const value = localStorage.getItem(KEY);
    return CHOICES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function resolve(choice) {
  if (choice === 'light' || choice === 'dark') return choice;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(choice = getChoice()) {
  const theme = resolve(choice);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[theme]);
  return theme;
}

export function setChoice(choice) {
  if (!CHOICES.includes(choice)) return;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // the theme still changes for this session
  }
  applyTheme(choice);
}

// When the choice is "System", follow the phone if its setting changes while the app is open.
export function watchSystemTheme() {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getChoice() === 'system') applyTheme('system');
  });
}
