import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NumberCell, neutralizeCell, toCsv } from '../src/core/csv.js';
import { normalizePhone } from '../src/core/phone.js';
import * as rules from '../src/core/rules.js';

test('phone numbers are written in one spelling', () => {
  const cases = {
    '9876543210': '+919876543210',
    '98765 43210': '+919876543210',
    '09876543210': '+919876543210',
    '919876543210': '+919876543210',
    '+91 98765-43210': '+919876543210',
    '0091 9876543210': '+919876543210',
    '+1 (415) 555-0100': '+14155550100',
  };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(normalizePhone(raw), expected, raw);
});

test('phone numbers that cannot be trusted give null', () => {
  for (const bad of ['2612345', 'abc', '', null, undefined, '5876543210', '+12']) assert.equal(normalizePhone(bad), null, String(bad));
});

test('PIN: a normal one is fine, easy guesses and wrong shapes are refused', () => {
  assert.equal(rules.pin('483920'), null);
  for (const bad of ['111111', '000000', '123456', '654321', '12345', '1234567', 'abcdef', '12 456', '', null]) {
    assert.notEqual(rules.pin(bad), null, String(bad));
  }
});

test('amounts are parsed into whole paise', () => {
  assert.equal(rules.parsePaise('450'), 45000);
  assert.equal(rules.parsePaise('450.5'), 45050);
  assert.equal(rules.parsePaise('1,234.05'), 123405);
  assert.equal(rules.parsePaise('0.10'), 10);
});

test('anything that is not a plain amount is refused', () => {
  for (const bad of ['', 'abc', '-5', '+5', '1e5', '1.234', '12345678', '5.', '.5', '1 000', null]) assert.equal(rules.parsePaise(bad), null, String(bad));
});

test('amount limits', () => {
  assert.notEqual(rules.amount('0'), null);
  assert.notEqual(rules.amount('0.00'), null);
  assert.equal(rules.amount('1000000'), null);
  assert.notEqual(rules.amount('1000000.01'), null);
  assert.equal(rules.amount('99'), null);

  assert.equal(rules.amountPaise(1), null);
  for (const bad of [0, -100, 100000001, 1.5, NaN, '100']) assert.notEqual(rules.amountPaise(bad), null, String(bad));
});

test('expense date: today, yesterday and tomorrow are fine; two days ahead, impossible and old dates are not', () => {
  const now = new Date(2026, 9, 24, 15);
  assert.equal(rules.expenseDate('2026-10-24', now), null);
  assert.equal(rules.expenseDate('2026-10-23', now), null);
  assert.equal(rules.expenseDate('2026-10-25', now), null);
  for (const bad of ['2026-10-26', '2019-12-31', '2026-02-30', '2026-13-01', '24-10-2026', '', null]) assert.notEqual(rules.expenseDate(bad, now), null, String(bad));
});

test('text rules', () => {
  assert.equal(rules.employeeCode('rep-001'), null);
  for (const bad of ['AB', 'REP 001', "REP';--", '']) assert.notEqual(rules.employeeCode(bad), null, bad);

  assert.notEqual(rules.required('  ', { label: 'Name' }), null);
  assert.notEqual(rules.required('a', { min: 2 }), null);
  assert.notEqual(rules.optional('x'.repeat(11), { max: 10 }), null);
  assert.equal(rules.optional(null), null);

  assert.equal(rules.phone(''), null);
  assert.notEqual(rules.phone('', true), null);
  assert.notEqual(rules.phone('12'), null);
  assert.equal(rules.phone('9876543210'), null);
});

test('pictures are recognised by their first bytes, not by their name', () => {
  assert.equal(rules.imageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'jpeg');
  assert.equal(rules.imageKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(rules.imageKind(new TextEncoder().encode('RIFF1234WEBPVP8 ')), 'webp');
  assert.equal(rules.imageKind(new TextEncoder().encode('<script>alert(1)</script>')), null);
  assert.equal(rules.imageKind(new TextEncoder().encode('GIF89a......')), null);
  assert.equal(rules.imageKind(new Uint8Array(0)), null);
});

test('csv: cells that could run as a formula get an apostrophe', () => {
  for (const risky of ['=1+1', '+91 98765', '-2+3', '@SUM(A1)', '\tx', '\rx']) assert.ok(neutralizeCell(risky).startsWith("'"), risky);
  assert.equal(neutralizeCell('Lab Co'), 'Lab Co');
  assert.equal(neutralizeCell(''), '');
  assert.equal(neutralizeCell(null), '');
});

test('csv: quotes, commas and line breaks are escaped; numbers are left alone', () => {
  const csv = toCsv([
    ['name', 'amount'],
    ['A, "B"', new NumberCell('12.50')],
    ['=cmd|calc', new NumberCell('-5.00')],
    ['line1\nline2', ''],
  ]);

  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"A, ""B""",12.50'));
  assert.ok(csv.includes("'=cmd|calc,-5.00"));
  assert.ok(csv.includes('"line1\nline2",'));
  assert.ok(csv.endsWith('\r\n'));
});
