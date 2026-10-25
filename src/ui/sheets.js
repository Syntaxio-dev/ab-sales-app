import { h, icon } from './dom.js';
import { closeTop, dialog } from './kit.js';

// A drop-down (<select>) opens the phone's own list, which ignores the app's theme. Instead, every select of the app opens this
// list in the app's look. The select stays the real thing underneath: the code that reads `.value` or listens to `change` is unchanged.

let open = false;

function titleOf(select) {
  const label = select.id ? document.querySelector(`label[for="${select.id}"]`)?.textContent?.trim() : '';
  return label || select.getAttribute('aria-label') || 'Choose';
}

export function openSelectSheet(select) {
  if (open || select.disabled) return;
  open = true;

  const rows = [...select.options].filter((o) => !o.hidden).map((o) => h('button', {
    type: 'button', class: 'sheet-option', role: 'option', 'aria-selected': String(o.index === select.selectedIndex), disabled: o.disabled,
    onclick() {
      select.selectedIndex = o.index;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      closeTop();
    },
  }, h('span', null, o.textContent), o.index === select.selectedIndex ? icon('check', 18) : null));

  const list = h('div', { class: 'sheet-list', role: 'listbox', 'aria-label': titleOf(select) }, rows);

  dialog({ title: titleOf(select), content: list, buttons: [{ label: 'Cancel', value: null }] }).finally(() => { open = false; });

  // show the chosen entry in the middle of a long list
  requestAnimationFrame(() => {
    const on = list.querySelector('[aria-selected="true"]');
    if (on) list.scrollTop = on.offsetTop - list.clientHeight / 2 + on.offsetHeight / 2;
  });
}

// Once, when the app starts: every select of every screen (also the ones made later) opens the list above.
export function installSelectSheets() {
  const selectOf = (event) => (event.target instanceof Element ? event.target.closest('select') : null);

  // a mouse (browser preview) and a finger (phone): a drag that only scrolls the page must not open it
  document.addEventListener('mousedown', (event) => {
    const select = selectOf(event);
    if (!select) return;
    event.preventDefault();
    openSelectSheet(select);
  }, true);

  let start = null;
  document.addEventListener('touchstart', (event) => {
    const t = event.touches[0];
    start = selectOf(event) ? { x: t.clientX, y: t.clientY } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchend', (event) => {
    const select = selectOf(event);
    const t = event.changedTouches[0];
    const moved = !start || Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10;
    start = null;
    if (!select || moved) return;
    event.preventDefault(); // no phone list, and no mouse events after it
    openSelectSheet(select);
  }, { capture: true, passive: false });

  document.addEventListener('keydown', (event) => {
    if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
    const select = selectOf(event);
    if (!select) return;
    event.preventDefault();
    openSelectSheet(select);
  }, true);
}
