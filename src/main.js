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
import { ALLOW_LOCAL_HTTP, API_BASE, SERVER_URL } from './config.js';
import { Vault } from './security/vault.js';
import { SyncEngine } from './sync/engine.js';
import { createHttp } from './sync/http.js';
import { renderLock, renderSignIn } from './ui/auth.js';
import { h, icon } from './ui/dom.js';
import { closeAll, closeTop, hasOpen } from './ui/kit.js';
import { applyTheme, watchSystemTheme } from './ui/theme.js';
import { resetCallsView } from './ui/calls.js';
import { renderGuide, resetGuideView } from './ui/guide.js';
import { renderEnquiries, resetEnquiryView } from './ui/enquiries.js';
import { renderClients, renderExpenses, renderHome, renderMeetings, resetTabViews } from './ui/tabs.js';

// Before anything is drawn: the saved light / dark choice (public/theme-init.js already did it before the first paint).
applyTheme();
watchSystemTheme();

// The order of the dock, and of the swipe: swipe left = the next tab, swipe right = the previous one.
const TABS = [
  { id: 'home', label: 'Home', icon: 'home', render: renderHome },
  { id: 'enquiries', label: 'Enquiries', icon: 'clipboard', render: renderEnquiries },
  { id: 'clients', label: 'Clients', icon: 'users', render: renderClients },
  { id: 'guide', label: 'Guide', icon: 'book', render: renderGuide },
  { id: 'meetings', label: 'Meetings', icon: 'calendar', render: renderMeetings },
  { id: 'expenses', label: 'Expenses', icon: 'receipt', render: renderExpenses },
];

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

// "Pixel 7" out of "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/...) ..." (the office only shows it in the rep list)
function deviceModel() {
  const match = /Android [\d.]+; ([^;)]+)/.exec(navigator.userAgent);
  return (match?.[1] ?? 'Unknown').replace(/\sBuild\/.*/, '').trim().slice(0, 100);
}

// The one link to the office: the first sign-in on a new phone, and the sync after it. No office address in this build (or an unsafe
// one) = no link: the app then cannot be set up at all, because only an account the manager made may use it.
function makeOfficeLink() {
  if (!SERVER_URL) return null;

  try {
    const http = createHttp({ base: API_BASE, allowLocalHttp: ALLOW_LOCAL_HTTP, appVersion: APP_VERSION });
    return {
      syncFactory: (store) => new SyncEngine({ store, http, appVersion: APP_VERSION, deviceModel: deviceModel() }),
      login: (login, password) => http.post('/auth/login', { login, password, app_version: APP_VERSION, device_model: deviceModel() }),
      logout: (token) => http.post('/auth/logout', {}, { token }),
    };
  } catch (error) {
    console.error('Office link disabled:', error?.name ?? 'Error');
    return null;
  }
}

async function boot() {
  const root = document.getElementById('app');

  const platform = Capacitor.isNativePlatform()
    ? await (await import('./platform/native.js')).createNativePlatform()
    : await (await import('./platform/web.js')).createWebPlatform();

  const link = makeOfficeLink();
  const app = new App({ vault: new Vault(platform.secrets), persist: platform.persist, platform, syncFactory: link?.syncFactory ?? null, officeLogin: link?.login ?? null, officeLogout: link?.logout ?? null });

  let tab = 'home';
  let leaveScreen = () => {};
  let unsubscribeStore = () => {};
  let cleanups = []; // what the current tab screen subscribed to; run before it is drawn again

  // ---- the three states of the app ------------------------------------------------

  function runCleanups() {
    const list = cleanups;
    cleanups = [];
    for (const fn of list) fn();
  }

  function show(phase) {
    leaveScreen();
    leaveScreen = () => {};
    unsubscribeStore();
    unsubscribeStore = () => {};
    runCleanups();
    resetTabViews();
    resetEnquiryView();
    resetCallsView();
    resetGuideView();
    closeAll(); // no form or dialog may stay on screen while locked

    // the page container is (re)built each time, below the optional preview banner
    root.replaceChildren(...(platform.native ? [] : [h('div', { class: 'preview-banner' }, 'PREVIEW ONLY: browser storage is not secure. Do not enter real data.')]));
    const screen = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } });
    root.append(screen);

    if (phase === 'setup') renderSignIn(screen, app);
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
      goTab: (id, direction = null) => {
        tab = id;
        draw(true, direction);
      },
      fab: (label, onclick) => fabSlot.replaceChildren(...(label ? [h('button', { class: 'btn primary fab-pill', onclick }, icon('plus', 18), label)] : [])),
      onCleanup: (fn) => cleanups.push(fn),
    };

    // animate: the screen fades up (only when the person changes tab, not when a saved record redraws the list)
    function draw(animate, direction = null) {
      const current = TABS.find((t) => t.id === tab);
      const keepScroll = animate ? 0 : view.scrollTop;

      view.classList.remove('reveal', 'from-next', 'from-prev');
      runCleanups();
      current.render(view, app, ctx);
      view.scrollTop = keepScroll;
      if (animate) {
        void view.offsetWidth; // restart the animation
        view.classList.add('reveal');
        if (direction) view.classList.add(direction === 'next' ? 'from-next' : 'from-prev');
      }

      drawDock();
    }

    // The dock, with a small number on the Enquiries tab: how many follow-ups wait for the rep. Its own function, because time passing
    // (a follow-up that falls due) changes the number without any data changing.
    function drawDock() {
      const waiting = app.store.actionableEnquiries().length;

      dock.replaceChildren(...TABS.map((t) => h('button', { class: 'tab', 'aria-current': t.id === tab ? 'page' : null, onclick: () => ctx.goTab(t.id, TABS.findIndex((x) => x.id === t.id) > TABS.findIndex((x) => x.id === tab) ? 'next' : 'prev') },
        h('span', { class: 'pill' }, icon(t.icon, 22), t.id === 'enquiries' && waiting ? h('i', { class: 'badge', 'aria-label': `${waiting} need action` }, waiting > 9 ? '9+' : String(waiting)) : null), t.label)));
    }

    // Swipe left = next tab, swipe right = previous tab (like Prysm). Not over fields, filter rows or open pages, and not at the very
    // edges of the screen (the phone's own back gesture lives there).
    let touch = null;
    view.addEventListener('touchstart', (event) => {
      const t = event.touches[0];
      const edge = 26;
      const blocked = hasOpen() || event.touches.length > 1 || t.clientX < edge || t.clientX > window.innerWidth - edge
        || event.target.closest?.('input, select, textarea, .filters, .people, .chips, .noswipe');
      touch = blocked ? null : { x: t.clientX, y: t.clientY, at: Date.now() };
    }, { passive: true });
    view.addEventListener('touchend', (event) => {
      if (!touch) return;
      const t = event.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      const quick = Date.now() - touch.at < 700;
      touch = null;
      if (hasOpen() || !quick || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;

      const next = TABS[TABS.findIndex((x) => x.id === tab) + (dx < 0 ? 1 : -1)];
      if (next) ctx.goTab(next.id, dx < 0 ? 'next' : 'prev');
    }, { passive: true });

    screen.append(h('div', { class: 'shell' }, view, fabSlot, dock));
    draw(true);

    // a saved change redraws the list underneath (open forms are not touched). While the rep is typing in a field of the screen itself
    // (a search box) the redraw waits until the field is left: a sync finishing must not take the keyboard away.
    let redrawLater = false;
    const typing = () => view.contains(document.activeElement) && document.activeElement?.matches?.('input, textarea, select');
    unsubscribeStore = app.store.subscribe(() => {
      if (typing()) redrawLater = true;
      else draw(false);
    });
    view.addEventListener('focusout', () => setTimeout(() => {
      if (redrawLater && !typing()) {
        redrawLater = false;
        draw(false);
      }
    }, 250));

    const clock = setInterval(drawDock, 60_000);
    leaveScreen = () => clearInterval(clock);
  }

  app.subscribe(show);

  // ---- lock when the app was away for a while, and the phone's back button --------------

  platform.onAppState((active) => (active ? app.backInForeground() : app.goneToBackground()));
  window.addEventListener('online', () => app.sync?.schedule(1500)); // the network is back: send what is waiting
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
