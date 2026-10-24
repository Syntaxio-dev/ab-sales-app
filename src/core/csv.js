// CSV for the "Export" feature. The file is opened in Excel by someone else, so any text that starts with
// = + - @ (or a tab / carriage return) could run as a formula there. Such cells get a leading apostrophe.
export function neutralizeCell(value) {
  const text = String(value ?? '');
  return text !== '' && ['=', '+', '-', '@', '\t', '\r'].includes(text[0]) ? `'${text}` : text;
}

function quote(value) {
  const safe = neutralizeCell(value);
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// A cell that is a real number (an amount): written as-is, so a "-" or "+" sign is not touched.
export class NumberCell {
  constructor(text) {
    this.text = text;
  }
}

// rows: arrays of cells, the first row is normally the header.
export function toCsv(rows) {
  const lines = rows.map((row) => row.map((cell) => (cell instanceof NumberCell ? cell.text : quote(cell))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`; // byte-order mark: Excel then reads the file as UTF-8
}
