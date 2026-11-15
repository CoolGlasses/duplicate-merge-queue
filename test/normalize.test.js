'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/normalize');

test('soundex: classic pairs agree, distinct names differ', () => {
  assert.equal(n.soundex('Robert'), 'R163');
  assert.equal(n.soundex('Rupert'), 'R163');
  assert.equal(n.soundex('Smith'), 'S530');
  assert.notEqual(n.soundex('Smith'), n.soundex('Jones'));
});

test('diacritics and punctuation fold', () => {
  assert.equal(n.normalizeText('José-Müller  '), 'jose muller');
  assert.equal(n.normalizeText("O'Brien"), 'o brien');
});

test('nickname canonicalization', () => {
  assert.equal(n.canonicalGivenName('Jon'), 'john');
  assert.equal(n.canonicalGivenName('Bobby'), 'robert');
  assert.equal(n.canonicalGivenName('Zelda'), 'zelda');
});

test('email: gmail dot/plus folding, googlemail fold', () => {
  const e = n.normalizeEmail('Jon.Smith+news@googlemail.com');
  assert.equal(e.domain, 'gmail.com');
  assert.equal(e.canonical, 'jonsmith@gmail.com');
  const f = n.normalizeEmail('Ann@Example.com');
  assert.equal(f.raw, 'ann@example.com');
  assert.equal(n.normalizeEmail('not-an-email').valid, false);
});

test('phone: NANP and international normalization', () => {
  assert.equal(n.normalizePhone('+1 (555) 010-2233').national, '5550102233');
  assert.equal(n.normalizePhone('555.010.2233').national, '5550102233');
  assert.equal(n.normalizePhone('+44 20 7946 0958').last10, '2079460958');
  assert.equal(n.normalizePhone('').digits, '');
});

test('domain normalization', () => {
  assert.equal(n.normalizeDomain('https://www.acme.com/about?x=1'), 'acme.com');
  assert.equal(n.normalizeDomain('ACME.COM'), 'acme.com');
});

test('levenshtein', () => {
  assert.equal(n.levenshtein('kitten', 'sitting'), 3);
  assert.equal(n.levenshtein('jon.smith', 'john.smith'), 1);
  assert.equal(n.levenshtein('same', 'same'), 0);
});
