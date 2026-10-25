import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { COUNTRIES, joinPhone, phoneProblem, splitPhone } from '../src/core/phone.js';
import * as rules from '../src/core/rules.js';
import { MemoryPersist } from '../src/data/persist.js';
import { Store, ValidationError } from '../src/data/store.js';
import { aesKey, randomBytes } from '../src/security/crypto.js';

// Forms must not let a wrong value in: the checks live in core/rules.js and core/phone.js, and the store repeats them.

let store;

beforeEach(async () => {
  store = await Store.open(new MemoryPersist(), await aesKey(randomBytes(32)));
  await store.saveProfile({ name: 'Test Rep', employeeCode: 'REP001' });
});

test('an Indian number is exactly 10 digits; a mobile starts with 6 to 9', () => {
  assert.equal(phoneProblem('91', '9876543210'), null);
  assert.equal(phoneProblem('91', '98765 43210'), null, 'spaces are ignored');
  assert.match(phoneProblem('91', '987654321'), /10 digits/);
  assert.match(phoneProblem('91', '98765432101'), /10 digits/);
  assert.match(phoneProblem('91', '5876543210'), /starts with 6, 7, 8 or 9/);
  assert.equal(phoneProblem('91', '1412345678', { landline: true }), null, 'a landline with its area code');
  assert.match(phoneProblem('91', '0412345678', { landline: true }), /cannot start with 0/);
  assert.equal(phoneProblem('91', ''), null, 'empty is the form\'s business (required or not)');
});

test('other countries have their own lengths and no leading 0', () => {
  assert.equal(phoneProblem('971', '501234567'), null);
  assert.match(phoneProblem('971', '5012'), /8 to 9 digits/);
  assert.equal(phoneProblem('1', '2025550123'), null);
  assert.match(phoneProblem('1', '202555012'), /10 digits/);
  assert.match(phoneProblem('44', '0123456789'), /Leave out the 0/);
});

test('a number is split into country and digits and joined back to one spelling', () => {
  assert.deepEqual(splitPhone('+919876543210'), { country: '91', national: '9876543210' });
  assert.deepEqual(splitPhone('9876543210'), { country: '91', national: '9876543210' });
  assert.deepEqual(splitPhone('+971501234567'), { country: '971', national: '501234567' });
  assert.deepEqual(splitPhone(''), { country: '91', national: '' });
  assert.equal(joinPhone('91', '98765 43210'), '+919876543210');
  assert.equal(joinPhone('91', ''), '');
  assert.ok(COUNTRIES[0].code === '91', 'India comes first');
  for (const c of COUNTRIES) assert.ok(c.min <= c.max && c.max + c.code.length <= 15, `${c.name} fits E.164`);
});

test('the store refuses a number that is not a real Indian number', async () => {
  assert.match(rules.phone('+91 12345'), /valid phone/);
  assert.match(rules.phone('+910123456789'), /exactly 10 digits/);
  assert.equal(rules.phone('+91 98765 43210'), null);
  assert.equal(rules.phone('+971 50 123 4567'), null);

  const client = await store.saveClient({ name: 'JK Cement', phone: '+91 1412345678' });
  assert.equal(client.phone, '+911412345678', 'a landline with its area code is a real number too');
  await assert.rejects(store.saveClient({ name: 'Bad Phone Ltd', phone: '+91 12345' }), ValidationError);
});

test('a person\'s name has letters only; a company name may have digits and & ( ) . ,', () => {
  for (const ok of ['Rohit Sharma', "Anita D'Souza", 'Dr. A.K. Singh', 'Mary-Ann Rao', 'राहुल शर्मा']) assert.equal(rules.personName(ok), null, ok);
  for (const bad of ['R', 'Rohit 2', 'Rohit<script>', 'A@B', '12345', '  ']) assert.notEqual(rules.personName(bad), null, bad);

  for (const ok of ['JK Cement', 'A&B Labs (P) Ltd.', 'M/s Shree Ram, Jaipur', '3M India', 'Lab-Tech #2']) assert.equal(rules.businessName(ok), null, ok);
  for (const bad of ['A', '<b>x</b>', '&&', ' ', 'Lab; DROP TABLE', 'x'.repeat(151)]) assert.notEqual(rules.businessName(bad), null, bad);

  assert.equal(rules.place('', { requiredField: false }), null);
  assert.equal(rules.place('Nimbahera'), null);
  assert.notEqual(rules.place('Jaipur 302001'), null);
});

test('the store applies the same name rules, so a bug in a screen cannot save a bad record', async () => {
  await assert.rejects(store.saveClient({ name: '<script>alert(1)</script>' }), ValidationError);
  await assert.rejects(store.saveClient({ name: 'JK Cement', city: 'Jaipur 302001' }), ValidationError);

  const client = await store.saveClient({ name: 'JK Cement', city: 'Nimbahera' });
  await assert.rejects(store.saveContact({ client_id: client.id, name: 'Rohit 2' }), ValidationError);
  await assert.rejects(store.saveContact({ client_id: client.id, name: 'Rohit Sharma', email: 'not an email' }), ValidationError);
  await assert.rejects(store.saveContact({ client_id: client.id, name: 'Rohit Sharma', phone: '12345' }), ValidationError);

  const person = await store.saveContact({ client_id: client.id, name: 'Rohit Sharma', phone: '98765 43210', email: 'rohit@jk.com' });
  assert.equal(person.phone, '+919876543210');
});

test('e-mail, quantity and control characters', () => {
  for (const ok of ['a@b.co', 'rohit.sharma+jk@jk-cement.com']) assert.equal(rules.email(ok), null, ok);
  for (const bad of ['a@b', '@b.com', 'a b@c.com', 'a@b.c', 'a@@b.com', 'a@b.com, c@d.com']) assert.notEqual(rules.email(bad), null, bad);
  assert.equal(rules.email(''), null);
  assert.notEqual(rules.email('', { requiredField: true }), null);

  assert.equal(rules.wholeNumber('1'), null);
  assert.equal(rules.wholeNumber('100000'), null);
  for (const bad of ['0', '100001', '1.5', '-3', 'abc', '', '1e3']) assert.notEqual(rules.wholeNumber(bad), null, bad);

  assert.equal(rules.optional('line one\nline two\ttabbed'), null, 'new lines and tabs are fine in a note');
  assert.notEqual(rules.optional('bad\u0000byte'), null);
  assert.notEqual(rules.required('bad\u001bescape'), null);
});
