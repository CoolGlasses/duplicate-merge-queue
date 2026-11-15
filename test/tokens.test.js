'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { TokenVault } = require('../src/tokens');

const KEY = crypto.randomBytes(32).toString('hex');
const bundle = { accessToken: 'at-123', refreshToken: 'rt-456', expiresAt: '2030-01-01T00:00:00Z' };

test('vault: encrypted roundtrip, ciphertext is opaque', () => {
  const v = new TokenVault({ TOKEN_ENC_KEY: KEY }, () => {});
  assert.equal(v.encrypted, true);
  const sealed = v.seal(bundle);
  assert.ok(sealed.startsWith('enc:v1:'));
  assert.ok(!sealed.includes('at-123'));
  assert.deepEqual(v.unseal(sealed), bundle);
});

test('vault: tampered ciphertext is rejected (GCM auth)', () => {
  const v = new TokenVault({ TOKEN_ENC_KEY: KEY }, () => {});
  const sealed = v.seal(bundle);
  const buf = Buffer.from(sealed.slice('enc:v1:'.length), 'base64');
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => v.unseal('enc:v1:' + buf.toString('base64')));
});

test('vault: no key -> plaintext with a loud warning, still roundtrips', () => {
  const warnings = [];
  const v = new TokenVault({}, (m) => warnings.push(m));
  assert.equal(v.encrypted, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PLAINTEXT/);
  const sealed = v.seal(bundle);
  assert.deepEqual(v.unseal(sealed), bundle);
});

test('vault: unsealing encrypted data without the key throws', () => {
  const enc = new TokenVault({ TOKEN_ENC_KEY: KEY }, () => {});
  const sealed = enc.seal(bundle);
  const noKey = new TokenVault({}, () => {});
  assert.throws(() => noKey.unseal(sealed), /TOKEN_ENC_KEY/);
});

test('vault: wrong key cannot decrypt', () => {
  const a = new TokenVault({ TOKEN_ENC_KEY: KEY }, () => {});
  const b = new TokenVault({ TOKEN_ENC_KEY: crypto.randomBytes(32).toString('hex') }, () => {});
  assert.throws(() => b.unseal(a.seal(bundle)));
});
