import { append, h, icon } from './dom.js';

// Pages (full-screen forms that slide up), dialogs and toasts. They sit in a stack, so the phone's back button
// closes the top one first. Locking the app closes all of them (see closeAll).

const stack = [];

function root() {
  return document.getElementById('app');
}

// ---- pages ------------------------------------------------------------------

// body: an element. footer: an optional element pinned under the scrolling body (the Save button).
// onClose runs when the page goes away.
export function openPage({ title, body, footer, onClose }) {
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

  // append() of dom.js skips empty parts (the native one would print the word "null")
  append(page, [
    h('header', { class: 'page-head' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: close }, icon('back', 20)),
      h('h1', null, title)),
    h('div', { class: 'page-body' }, body),
    footer ? h('div', { class: 'page-foot' }, footer) : null,
  ]);

  root().append(page);
  stack.push(entry);
  return { close };
}

// ---- dialogs ----------------------------------------------------------------

// buttons: [{ label, value, primary?, danger?, onclick? }]. Resolves with the value of the pressed button
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

// Is a page or dialog on top of the screen? (a swipe between tabs must not work then)
export const hasOpen = () => stack.length > 0;

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

// ---- form pieces ------------------------------------------------------------

let fieldCounter = 0;

// A labelled input with room for an error message under it.
// variant 'row': the label sits inside a bordered surface row (the date and note of an expense).
export function field(label, input, hint, variant = 'plain') {
  const error = h('div', { class: 'err', role: 'alert' });
  const id = input.id || `f${++fieldCounter}`;
  input.id = id;

  const labelEl = h('label', { htmlFor: id }, label);
  const el = variant === 'row'
    ? h('div', { class: 'field' }, h('div', { class: 'srow-box' }, labelEl, input), hint ? h('div', { class: 'muted small' }, hint) : null, error)
    : h('div', { class: 'field' }, labelEl, input, hint ? h('div', { class: 'muted small' }, hint) : null, error);

  return slot(el, input, error);
}

// Wraps any element (for example the big amount card) so validate() can show an error under it.
export function slot(el, input, error = h('div', { class: 'err', role: 'alert' })) {
  const wrapper = el.classList.contains('field') ? el : h('div', { class: 'field' }, el, error);

  return {
    el: wrapper,
    input,
    setError(message) {
      error.textContent = message ?? '';
      wrapper.classList.toggle('bad', Boolean(message));
    },
  };
}

// Single-choice chips (the expense category). Returns { el, get value(), set value(v) }.
export function chipGroup(options, initial, onChange) {
  let current = initial;
  const el = h('div', { class: 'chips', role: 'radiogroup' });

  const draw = () => {
    el.replaceChildren(...options.map(({ value, label }) => h('button', {
      class: 'filter', type: 'button', role: 'radio', 'aria-checked': String(value === current),
      onclick() {
        current = value;
        draw();
        onChange?.(value);
      },
    }, label)));
  };
  draw();

  return {
    el,
    get value() { return current; },
    set value(v) { current = v; draw(); },
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
