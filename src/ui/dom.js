// Tiny DOM helper. Text always goes in as a text node, so what a rep types (a client name, a note) can never be
// read as HTML. innerHTML / outerHTML / insertAdjacentHTML are refused here and checked by a test over all of src/.

const FORBIDDEN = new Set(['innerHTML', 'outerHTML', 'srcdoc']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);

  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (FORBIDDEN.has(name)) throw new Error(`"${name}" is not allowed`);

    if (name === 'class') el.className = value;
    else if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === 'dataset') Object.assign(el.dataset, value);
    else if (name === 'style' && typeof value === 'object') Object.assign(el.style, value); // CSSOM, allowed by the CSP
    else if (name in el && name !== 'list' && name !== 'form') el[name] = value;
    else el.setAttribute(name, value === true ? '' : String(value));
  }

  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// An inline SVG icon from a fixed list (paths are ours, never user text).
const ICONS = {
  home: 'M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  image: 'M4 5h16v14H4zM8 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 17l5-5 4 4 3-3 4 4',
  alarm: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2 2M5 3 3 5M19 3l2 2',
  share: 'M12 3v12M8 7l4-4 4 4M5 13v7h14v-7',
  key: 'M14 10a4 4 0 1 0-3.9 4L21 14v3h-3v3h-3v-3l-2-2',
  shield: 'M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6z',
  alert: 'M12 4 2.5 20h19zM12 10v4M12 17v.5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  backspace: 'M21 5H9l-6 7 6 7h12zM15 9l-4 6M11 9l4 6',
  menu: 'M4 7h16M4 12h16M4 17h10',
  car: 'M5 16v-4l2-5h10l2 5v4zM5 16v3M19 16v3M7 12h10',
  utensils: 'M7 3v7M4.5 3v4.5a2.5 2.5 0 0 0 5 0V3M7 10v11M17 3c-2.2 1.2-3 3.6-3 6.5V13h3M17 3v18',
  bed: 'M3 19V6M3 15h18v4M21 15v-3a3 3 0 0 0-3-3h-7v6M7.5 12.5a1.5 1.5 0 1 0 0-.01',
  fuel: 'M5 21V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16M3 21h13M7 8h5M14 9h1.5A2.5 2.5 0 0 1 18 11.5V16a1.5 1.5 0 0 0 3 0V9.5L18.5 7',
  check: 'M5 12.5l4.5 4.5L19 7.5',
};

export function icon(name, size = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.alert);
  svg.append(path);
  return svg;
}

// Any other inline SVG element (the orbit motif on the hero card). Attributes are set one by one (never as a style string),
// so the strict CSP stays happy.
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}
