import { h, icon } from './dom.js';

// Small building blocks of the main screens (shared by tabs.js and calls.js).

// replaceChildren() would print the word "null" for an empty part: this skips them
export const fill = (el, ...parts) => el.replaceChildren(...parts.filter(Boolean));

export const empty = (iconName, title, text) =>
  h('div', { class: 'empty' }, icon(iconName, 52), h('h2', null, title), h('p', null, text));

// Large title row: small mono eyebrow, Sora title, optional things on the right.
export function head({ eyebrow, title, right }) {
  return h('header', { class: 'head' },
    h('div', { class: 'grow' }, eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null, h('h1', null, title)),
    right ? h('div', { class: 'head-right' }, right) : null);
}
