'use strict';
/*
 * OAuth token storage encryption. AES-256-GCM with a 32-byte key from
 * TOKEN_ENC_KEY (64 hex chars, or base64). Stored format:
 *   enc:v1:<base64(iv | authTag | ciphertext)>
 * If no valid key is configured (dev only), tokens are stored as
 * plaintext and a loud warning is logged — never silently.
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function parseKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  try {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
  } catch (_) { /* fall through */ }
  return null;
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(value, key) {
  const buf = Buffer.from(String(value).slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

class TokenVault {
  /** env: process.env-like object. logger: fn(string). */
  constructor(env, logger) {
    this.key = parseKey(env && env.TOKEN_ENC_KEY);
    this.warned = false;
    this.logger = logger || ((m) => console.error(m));
    if (!this.key) this.warnPlaintext();
  }

  warnPlaintext() {
    if (this.warned) return;
    this.warned = true;
    this.logger('*** WARNING: TOKEN_ENC_KEY is missing or invalid — OAuth tokens will be stored in PLAINTEXT. Set TOKEN_ENC_KEY before connecting any real portal. ***');
  }

  get encrypted() { return Boolean(this.key); }

  /** Serialize a token bundle {accessToken, refreshToken, expiresAt} for storage. */
  seal(bundle) {
    const json = JSON.stringify(bundle);
    return this.key ? encrypt(json, this.key) : json;
  }

  /** Reverse seal(). Tolerates legacy plaintext JSON. */
  unseal(stored) {
    if (!stored) return null;
    if (String(stored).startsWith(PREFIX)) {
      if (!this.key) throw new Error('stored tokens are encrypted but TOKEN_ENC_KEY is not configured');
      return JSON.parse(decrypt(stored, this.key));
    }
    return JSON.parse(stored);
  }
}

module.exports = { TokenVault, parseKey, encrypt, decrypt, PREFIX };
