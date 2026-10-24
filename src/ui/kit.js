import { h, icon } from './dom.js';

// Pages (full-screen forms that slide up), dialogs and toasts. They sit in a stack, so the phone's back button
// closes the top one first. Locking the app closes all of them (see closeAll).

const stack = [];

function root() {
  return document.getElementById('app');
}

// ---- pages ------------------------------------------------------------------

// body: an element (or a function that gets { close } and returns one). onClose runs when the page goes away.
export function openPage({ title, body, onClose }) {
  const page = h('section', { class: 'page', role: 'dialog', 'aria-label': title });
  const entry = { el: page, onClose, closing: false };

  const close = () => {
    if (entry.closing) return;
    entry.closing = true;
    stack.splice(stack.indexOf(entry), 1);
    page.classList.add('leaving');
    setTimeout(() => page.remove(), 280);
    entry.onClose?.();
  };
  entry.close = close;

  page.append(
    h('header', { class: 'topbar' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: close }, icon('back')),
      h('h1', null, title)),
    h('div', { class: 'view' }, typeof body === 'function' ? body({ close }) : body),
  );

  root().append(page);
  stack.push(entry);
  return { close };
}

// ---- dialogs ----------------------------------------------------------------

// buttons: [{ label, value, primary?, danger?, keepOpen? }]. Resolves with the value of the pressed button
// (or undefined when closed with the back button).
export function dialog({ title, content, buttons }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      stack.splice(stack.indexOf(entry), 1);
      scrim.remove();
      resolve(value);
    };

    const scrim = h('div', { class: 'scrim', role: 'presentation' },
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-label': title },
        h('h2', null, title),
        content,
        h('div', { class: 'actions' },
          buttons.map((b) => h('button', {
            class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`,
            onclick: (event) => (b.onclick ? b.onclick(event, finish) : finish(b.value)),
          }, b.label)))));

    const entry = { el: scrim, close: () => finish(undefined) };
    stack.push(entry);
    root().append(scrim);
  });
}

export async function confirmDialog({ title, text, yes = 'Delete', danger = true }) {
  const answer = await dialog({
    title,
    content: h('p', { class: 'muted' }, text),
    buttons: [{ label: 'Cancel', value: false }, { label: yes, value: true, primary: !danger, danger }],
  });
  return answer === true;
}

export function alertDialog(title, text) {
  return dialog({ title, content: h('p', { class: 'muted' }, text), buttons: [{ label: 'OK', value: true, primary: true }] });
}

// ---- toast ------------------------------------------------------------------

let toastTimer = 0;

export function toast(text) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);

  const el = h('div', { class: 'toast', role: 'status' }, text);
  root().append(el);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

// ---- back button ------------------------------------------------------------

// Closes the top dialog or page. Returns false when there was nothing open.
export function closeTop() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function closeAll() {
  while (stack.length) {
    const entry = stack.pop();
    entry.closing = true;
    entry.onClose?.();
    entry.el.remove();
  }
  document.querySelector('.toast')?.remove();
}

export function hasOpenOverlay() {
  return stack.length > 0;
}

// ---- form pieces ------------------------------------------------------------

// A labelled input with room for an error message under it.
export function field(label, input, hint) {
  const error = h('div', { class: 'err', role: 'alert' });
  const el = h('div', { class: 'field' },
    h('label', null, label),
    input,
    hint ? h('div', { class: 'muted small' }, hint) : null,
    error);

  // tie the label to the input for screen readers and for a bigger tap area
  const id = input.id || `f${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  el.querySelector('label').htmlFor = id;

  return {
    el,
    input,
    setError(message) {
      error.textContent = message ?? '';
      el.classList.toggle('bad', Boolean(message));
    },
  };
}

// Shows an error under each field, scrolls to the first one, and returns true when everything is fine.
export function validate(checks) {
  let first = null;
  for (const [f, message] of checks) {
    f.setError(message);
    if (message && !first) first = f;
  }
  first?.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return !first;
}
