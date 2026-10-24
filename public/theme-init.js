// Runs before the first paint (a plain script in <head>, allowed by the CSP because it is the app's own file),
// so a dark phone never shows a white flash. The same rule lives in src/ui/theme.js; the choice is not secret.
(function () {
  try {
    var choice = localStorage.getItem('ab-theme');
    if (choice !== 'light' && choice !== 'dark') choice = 'system';
    var dark = choice === 'dark' || (choice === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#000000' : '#0B2545');
  } catch (e) {
    // storage not available: the light theme is used
  }
})();
