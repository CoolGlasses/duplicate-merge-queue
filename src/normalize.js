'use strict';
/*
 * Normalization primitives for the matching engine. Pure functions, no
 * dependencies. Everything here is deterministic: the same input always
 * produces the same output, which is what makes match scores explainable
 * and testable.
 */

/** Remove diacritics: "José" -> "Jose", "Müller" -> "Muller". */
function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '');
}

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
function normalizeText(s) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * Nickname / variant table: variant -> canonical given name. Deliberately
 * conservative — only well-established English-language variants. A name
 * not in the table canonicalizes to itself.
 */
const NICKNAMES = {
  jon: 'john', johnny: 'john', jonny: 'john', jack: 'john',
  bob: 'robert', rob: 'robert', bobby: 'robert', bert: 'robert',
  bill: 'william', will: 'william', willie: 'william', liam: 'william',
  mike: 'michael', mick: 'michael', mickey: 'michael',
  jim: 'james', jimmy: 'james', jamie: 'james',
  joe: 'joseph', joey: 'joseph',
  tom: 'thomas', tommy: 'thomas',
  dick: 'richard', rick: 'richard', rich: 'richard', richie: 'richard',
  kate: 'katherine', katie: 'katherine', cathy: 'katherine', kathy: 'katherine', kat: 'katherine',
  liz: 'elizabeth', beth: 'elizabeth', betty: 'elizabeth', eliza: 'elizabeth',
  peggy: 'margaret', meg: 'margaret', maggie: 'margaret',
  hank: 'henry', harry: 'henry',
  ted: 'edward', ed: 'edward', eddie: 'edward', ned: 'edward',
  dan: 'daniel', danny: 'daniel',
  dave: 'david',
  steve: 'steven', stephen: 'steven',
  chris: 'christopher',
  pat: 'patrick',
  sam: 'samuel',
  ben: 'benjamin',
  alex: 'alexander',
  nick: 'nicholas',
  tony: 'anthony',
  andy: 'andrew',
  charlie: 'charles', chuck: 'charles',
  fred: 'frederick',
  jake: 'jacob',
  zach: 'zachary', zack: 'zachary',
  josh: 'joshua',
  matt: 'matthew',
  jeff: 'jeffrey',
  greg: 'gregory',
  ron: 'ronald',
  don: 'donald',
  larry: 'lawrence',
  jerry: 'gerald',
  sue: 'susan', suzy: 'susan',
  jenny: 'jennifer', jen: 'jennifer',
  jess: 'jessica',
  mandy: 'amanda',
  abby: 'abigail',
  becky: 'rebecca',
  deb: 'deborah', debbie: 'deborah',
  kim: 'kimberly',
  lisa: 'elizabeth',
  vicky: 'victoria', vicki: 'victoria', tori: 'victoria',
  steph: 'stephanie',
  mel: 'melissa',
  angie: 'angela',
};

function canonicalGivenName(first) {
  const n = normalizeText(first).split(' ')[0] || '';
  return NICKNAMES[n] || n;
}

/*
 * American Soundex. Classic algorithm: keep the first letter, map
 * consonants to digits (b/f/p/v=1, c/g/j/k/q/s/x/z=2, d/t=3, l=4,
 * m/n=5, r=6), drop vowels and h/w (h/w do not break adjacency),
 * collapse adjacent duplicates, pad/truncate to letter + 3 digits.
 */
const SOUNDEX_MAP = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
function soundex(input) {
  const s = normalizeText(input).replace(/\s/g, '');
  if (!s) return '';
  const first = s[0];
  let prev = SOUNDEX_MAP[first] || 0;
  let out = first.toUpperCase();
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const ch = s[i];
    if (ch === 'h' || ch === 'w') continue;
    const code = SOUNDEX_MAP[ch] || 0;
    if (code !== 0 && code !== prev) out += String(code);
    if (ch !== 'a' && ch !== 'e' && ch !== 'i' && ch !== 'o' && ch !== 'u' && ch !== 'y') prev = code;
    else prev = 0;
  }
  return (out + '000').slice(0, 4);
}

/** Levenshtein edit distance (full DP, inputs here are short). */
function levenshtein(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/*
 * Email normalization. Returns:
 *  raw       — trimmed, lowercased full address
 *  local     — local part as-is
 *  domain    — domain (googlemail.com folded to gmail.com)
 *  canonical — for gmail: dots removed and +tag stripped from local.
 *              For other domains: local with +tag stripped.
 * Canonical equality is a SIGNAL (same mailbox, likely), never a rule.
 */
function normalizeEmail(input) {
  const raw = String(input || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 1) return { raw, local: raw, domain: '', canonical: raw, valid: false };
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  const plus = local.indexOf('+');
  const noTag = plus >= 0 ? local.slice(0, plus) : local;
  const canonicalLocal = domain === 'gmail.com' ? noTag.replace(/\./g, '') : noTag;
  return { raw, local, domain, canonical: `${canonicalLocal}@${domain}`, valid: true };
}

/*
 * Phone normalization. digits: all digits; national: digits with a
 * leading country code stripped when recognizable (1 for NANP, plus a
 * generic rule: if >10 digits, keep the last 10 as `last10`).
 */
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return { digits: '', national: '', last10: '' };
  let national = digits;
  if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);
  else if (digits.length > 11 && digits.startsWith('001')) national = digits.slice(3);
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  return { digits, national, last10 };
}

/** Domain normalization for companies: host only, no www, lowercase. */
function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split(':')[0];
  if (d.startsWith('www.')) d = d.slice(4);
  return d;
}

/** Split a person's name into first/last tokens (normalized). */
function splitName(firstname, lastname, fullFallback) {
  let first = normalizeText(firstname || '');
  let last = normalizeText(lastname || '');
  if (!first && !last && fullFallback) {
    const parts = normalizeText(fullFallback).split(' ').filter(Boolean);
    if (parts.length === 1) { first = parts[0]; }
    else if (parts.length > 1) { first = parts[0]; last = parts[parts.length - 1]; }
  }
  return { first: first.split(' ')[0] || '', last: last.split(' ').pop() || '' };
}

module.exports = {
  stripDiacritics, normalizeText, canonicalGivenName, NICKNAMES,
  soundex, levenshtein, normalizeEmail, normalizePhone, normalizeDomain, splitName,
};
