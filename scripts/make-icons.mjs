// Builds every logo-derived image from assets/ab-logo.png (the company logo: a test-tube and atom mark, then the name):
//   Android launcher icons (legacy square, round, adaptive foreground) and the splash screens.
//
// Run after changing the logo:   npm i --no-save sharp && node scripts/make-icons.mjs
// (sharp is only needed here, so it is not a project dependency.) Do not hand-edit the generated PNGs.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'assets', 'ab-logo.png');
const RES = join(root, 'android', 'app', 'src', 'main', 'res');
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 255, g: 255, b: 255, alpha: 0 };

const write = (path, buf) => {
  mkdirSync(dirname(path), { recursive: true });
  return sharp(buf).png({ compressionLevel: 9 }).toFile(path);
};

// The logo is "mark + name" side by side. The mark is the left part: find its box by looking for ink there.
async function markBox() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const inked = (x, y) => {
    const i = (y * info.width + x) * 4;
    return data[i + 3] > 20 && (data[i] + data[i + 1] + data[i + 2]) / 3 < 235;
  };

  // the mark ends at the first gap of 10 empty columns after it starts (the name's first letter comes after that gap)
  const columns = [];
  for (let x = 0; x < Math.round(info.width * 0.5); x++) {
    let any = false;
    for (let y = 0; y < info.height && !any; y++) any = inked(x, y);
    columns.push(any);
  }
  const first = columns.indexOf(true);
  let last = first;
  for (let x = first, empty = 0; x < columns.length && empty < 10; x++) {
    if (columns[x]) { last = x; empty = 0; } else empty++;
  }

  let minY = 1e9, maxY = 0;
  for (let y = 0; y < info.height; y++) for (let x = first; x <= last; x++) if (inked(x, y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); break; }
  return { left: first, top: minY, width: last - first + 1, height: maxY - minY + 1 };
}

const box = await markBox();
const markPng = await sharp(SRC).extract(box).png().toBuffer();

// the mark scaled to fit inside a square of `size` px, centred on `background`
async function square(size, frac, background) {
  const inner = Math.round(size * frac);
  const mark = await sharp(markPng).resize(inner, inner, { fit: 'inside', background: CLEAR }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } }).composite([{ input: mark, gravity: 'centre' }]).png().toBuffer();
}

const mask = (size, shape) => {
  const r = shape === 'round' ? size / 2 : size * 0.22;
  return Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
};

const dpis = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const jobs = [];

for (const [d, k] of Object.entries(dpis)) {
  const legacy = Math.round(48 * k);
  const fg = Math.round(108 * k);
  const full = await square(legacy, 0.78, WHITE);

  jobs.push(write(join(RES, `mipmap-${d}`, 'ic_launcher.png'), await sharp(full).composite([{ input: mask(legacy, 'square'), blend: 'dest-in' }]).png().toBuffer()));
  jobs.push(write(join(RES, `mipmap-${d}`, 'ic_launcher_round.png'), await sharp(full).composite([{ input: mask(legacy, 'round'), blend: 'dest-in' }]).png().toBuffer()));
  // adaptive icon (Android 8+): transparent foreground; the mark stays inside the 66dp safe zone of the 108dp canvas
  jobs.push(write(join(RES, `mipmap-${d}`, 'ic_launcher_foreground.png'), await square(fg, 0.56, CLEAR)));
}

// splash (shown while the app starts): the full logo on white, about 62% of the width
const sizes = {
  'drawable': [480, 320],
  'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720], 'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280],
};
for (const [dir, [w, h]] of Object.entries(sizes)) {
  const logoW = Math.round(Math.min(w * 0.62, h * 1.1));
  const logo = await sharp(SRC).resize({ width: logoW }).png().toBuffer();
  jobs.push(write(join(RES, dir, 'splash.png'), await sharp({ create: { width: w, height: h, channels: 4, background: WHITE } }).composite([{ input: logo, gravity: 'centre' }]).png().toBuffer()));
}

await Promise.all(jobs);
console.log(`mark box ${box.width}x${box.height} at ${box.left},${box.top}; wrote ${jobs.length} images`);
