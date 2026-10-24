import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/latin-800.css';
import '@fontsource/manrope/latin-ext-500.css';
import '@fontsource/manrope/latin-ext-700.css';
import '@fontsource/sora/latin-500.css';
import '@fontsource/sora/latin-600.css';
import '@fontsource/sora/latin-700.css';
import '@fontsource/sora/latin-ext-500.css';
import '@fontsource/sora/latin-ext-600.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import { Capacitor } from '@capacitor/core';

import './style.css';
import { App } from './app.js';
import { Vault } from './security/vault.js';
import { renderLock, renderSetup } from './ui/auth.js';
import { h, icon } from './ui/dom.js';
import { closeAll, closeTop } from './ui/kit.js';
import { applyTheme, watchSystemTheme } from './ui/theme.js';
import { renderClients, renderExpenses, renderHome, renderMeetings } from './ui/tabs.js';

// Before anything is drawn: the saved light / dark choice (public/theme-init.js already did it before the first paint).
applyTheme();
watchSystemTheme();

const TABS = [
  { id: 'home', label: 'Home', icon: 'home', render: renderHome },
  { id: 'expenses', label: 'Expenses', icon: 'receipt', render: renderExpenses },
  { id: 'clients', label: 'Clients', icon: 'users', render: renderClients },
  { id: 'meetings', label: 'Meetings', icon: 'calendar', render: renderMeetings },
];

async function boot() {
  const root = document.getElementById('app');

  const platform = Capacitor.isNativePlatform()
    ? await (await import('./platform/native.js')).createNativePlatform()
    : await (await import('./platform/web.js')).createWebPlatform();

  const app = new App({ vault: new Vault(platform.secrets), persist: platform.persist, platform });

  let tab = 'home';
  let leaveScreen = () => {};
  let unsubscribeStore = () => {};

  // ---- the three states of the app ------------------------------------------------

  function show(phase) {
    leaveScreen();
    leaveScreen = () => {};
    unsubscribeStore();
    unsubscribeStore = () => {};
    closeAll(); // no form or dialog may stay on screen while locked

    // the page container is (re)built each time, below the optional preview banner
    root.replaceChildren(...(platform.native ? [] : [h('div', { class: 'preview-banner' }, 'PREVIEW ONLY: browser storage is not secure. Do not enter real data.')]));
    const screen = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } });
    root.append(screen);

    if (phase === 'setup') renderSetup(screen, app);
    else if (phase === 'locked') leaveScreen = renderLock(screen, app) ?? (() => {});
    else if (phase === 'unlocked') {
      tab = 'home';
      renderShell(screen);
    }
  }

  // Large-title screen on the background, a floating dock at the bottom and a floating "add" button above it.
  function renderShell(screen) {
    const view = h('main', { class: 'view' });
    const dock = h('nav', { class: 'dock', 'aria-label': 'Sections' });
    const fabSlot = h('div', { class: 'fab-slot' });

    const ctx = {
      goTab: (id) => {
        tab = id;
        draw(true);
      },
      fab: (label, onclick) => fabSlot.replaceChildren(...(label ? [h('button', { class: 'btn primary fab-pill', onclick }, icon('plus', 18), label)] : [])),
    };

    // animate: the screen fades up (only when the person changes tab, not when a saved record redraws the list)
    function draw(animate) {
      const current = TABS.find((t) => t.id === tab);
      const keepScroll = animate ? 0 : view.scrollTop;

      view.classList.remove('reveal');
      current.render(view, app, ctx);
      view.scrollTop = keepScroll;
      if (animate) view.classList.add('reveal');

      dock.replaceChildren(...TABS.map((t) => h('button', { class: 'tab', 'aria-current': t.id === tab ? 'page' : null, onclick: () => ctx.goTab(t.id) },
        h('span', { class: 'pill' }, icon(t.icon, 22)), t.label)));
    }

    screen.append(h('div', { class: 'shell' }, view, fabSlot, dock));
    draw(true);

    // a saved change redraws the list underneath (open forms are not touched)
    unsubscribeStore = app.store.subscribe(() => draw(false));
  }

  app.subscribe(show);

  // ---- lock when the app was away for a while, and the phone's back button --------------

  platform.onAppState((active) => (active ? app.backInForeground() : app.goneToBackground()));
  platform.onBackButton(() => {
    if (closeTop()) return true;
    if (app.phase === 'unlocked' && tab !== 'home') {
      document.querySelector('.dock .tab')?.click(); // the first tab is Home
      return true;
    }
    return false;
  });

  await app.init();
}

boot().catch((error) => {
  // never show internals (or record contents) to the person; the console only gets the kind of error
  console.error('Startup failed:', error?.name ?? 'Error');
  document.getElementById('app').replaceChildren(h('div', { class: 'center' }, h('div', { class: 'col left' },
    h('h1', { class: 'title-xl' }, 'Could not start'),
    h('p', { class: 'muted' }, 'The app could not open its storage. Close it fully and open it again. If it keeps happening, tell your manager.'))));
});
