import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/600.css';
import { Capacitor } from '@capacitor/core';

import './style.css';
import { App } from './app.js';
import { Vault } from './security/vault.js';
import { renderLock, renderSetup } from './ui/auth.js';
import { h, icon } from './ui/dom.js';
import { closeAll, closeTop } from './ui/kit.js';
import { openSettings } from './ui/settings.js';
import { renderClients, renderExpenses, renderHome, renderMeetings } from './ui/tabs.js';

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

  function renderShell(screen) {
    const title = h('h1');
    const view = h('main', { class: 'view' });
    const tabsBar = h('nav', { class: 'tabs', 'aria-label': 'Sections' });

    const draw = () => {
      const current = TABS.find((t) => t.id === tab);
      title.textContent = current.label;
      view.scrollTop = 0;
      current.render(view, app, { goTab });
      tabsBar.replaceChildren(...TABS.map((t) => h('button', { class: 'tab', 'aria-current': t.id === tab ? 'page' : null, onclick: () => goTab(t.id) },
        h('span', { class: 'pill' }, icon(t.icon, 22)), t.label)));
    };
    const goTab = (id) => {
      tab = id;
      draw();
    };

    screen.append(
      h('header', { class: 'topbar' },
        title,
        h('button', { class: 'iconbtn', 'aria-label': 'Lock now', onclick: () => app.lock() }, icon('lock')),
        h('button', { class: 'iconbtn', 'aria-label': 'Settings', onclick: () => openSettings(app) }, icon('settings'))),
      view,
      tabsBar,
    );

    draw();
    // a saved change redraws the list underneath (open forms are not touched)
    unsubscribeStore = app.store.subscribe(() => {
      const keepScroll = view.scrollTop;
      const current = TABS.find((t) => t.id === tab);
      current.render(view, app, { goTab });
      view.scrollTop = keepScroll;
    });
  }

  app.subscribe(show);

  // ---- lock when the app was away for a while, and the phone's back button --------------

  platform.onAppState((active) => (active ? app.backInForeground() : app.goneToBackground()));
  platform.onBackButton(() => {
    if (closeTop()) return true;
    if (app.phase === 'unlocked' && tab !== 'home') {
      document.querySelector('.tab')?.click(); // first tab is Home
      return true;
    }
    return false;
  });

  await app.init();
}

boot().catch((error) => {
  // never show internals (or record contents) to the person; the console only gets the kind of error
  console.error('Startup failed:', error?.name ?? 'Error');
  document.getElementById('app').replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card pad stack' },
    h('h1', null, 'Could not start'),
    h('p', { class: 'muted' }, 'The app could not open its storage. Close it fully and open it again. If it keeps happening, tell your manager.'))));
});
