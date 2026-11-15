'use strict';
/*
 * The matching engine. Pure functions over HubSpot-shaped records:
 *   contact:  { id, properties: { firstname, lastname, email, phone,
 *               company, ... }, createdAt, updatedAt }
 *   company:  { id, properties: { name, domain, phone, ... }, ... }
 *
 * scorePair returns { score, caution, reasons: [{signal, points, detail}] }.
 * Every point is explained — a human reviews every proposal, so a score
 * nobody can interrogate is worthless.
 *
 * Thresholds: >= 85 propose merge · 60–84 propose with caution · < 60 ignore.
 */
const {
  normalizeText, canonicalGivenName, soundex, levenshtein,
  normalizeEmail, normalizePhone, normalizeDomain, splitName,
} = require('./normalize');

const PROPOSE_THRESHOLD = 85;
const CAUTION_THRESHOLD = 60;

function props(rec) { return (rec && rec.properties) || {}; }

/* ---------------- contact signals ---------------- */

function nameScore(a, b, reasons) {
  const na = splitName(props(a).firstname, props(a).lastname, props(a).name);
  const nb = splitName(props(b).firstname, props(b).lastname, props(b).name);
  if (!na.first && !na.last) return 0;
  if (!nb.first && !nb.last) return 0;
  const fullA = `${na.first} ${na.last}`.trim();
  const fullB = `${nb.first} ${nb.last}`.trim();
  if (fullA && fullA === fullB) {
    reasons.push({ signal: 'name_exact', points: 30, detail: `Names match exactly ("${fullA}")` });
    return 30;
  }
  const canA = `${canonicalGivenName(na.first)} ${na.last}`.trim();
  const canB = `${canonicalGivenName(nb.first)} ${nb.last}`.trim();
  if (canA && canA === canB) {
    reasons.push({ signal: 'name_variant', points: 26, detail: `Names match via nickname/variant table ("${fullA}" ~ "${fullB}")` });
    return 26;
  }
  if (na.last && na.last === nb.last && na.first && nb.first && soundex(na.first) === soundex(nb.first)) {
    reasons.push({ signal: 'name_phonetic', points: 18, detail: `Same last name, phonetically matching first names ("${na.first}" ~ "${nb.first}")` });
    return 18;
  }
  if (na.last && na.last === nb.last && na.first && nb.first && na.first[0] === nb.first[0]) {
    reasons.push({ signal: 'name_last_plus_initial', points: 12, detail: `Same last name and first initial` });
    return 12;
  }
  if (na.last && na.last === nb.last) {
    reasons.push({ signal: 'name_last_only', points: 8, detail: `Same last name only` });
    return 8;
  }
  if (na.first && na.first === nb.first) {
    reasons.push({ signal: 'name_first_only', points: 6, detail: `Same first name only` });
    return 6;
  }
  return 0;
}

function emailScore(a, b, reasons) {
  const ea = normalizeEmail(props(a).email);
  const eb = normalizeEmail(props(b).email);
  if (!ea.valid || !eb.valid) return 0;
  if (ea.raw === eb.raw) {
    reasons.push({ signal: 'email_exact', points: 55, detail: `Identical email (${ea.raw})` });
    return 55;
  }
  if (ea.canonical === eb.canonical) {
    reasons.push({ signal: 'email_canonical', points: 45, detail: `Same mailbox after dot/plus-tag normalization (${ea.canonical})` });
    return 45;
  }
  if (ea.domain && ea.domain === eb.domain) {
    const d = levenshtein(ea.local, eb.local);
    if (d === 1 || d === 2) {
      const pts = d === 1 ? 34 : 26;
      reasons.push({ signal: 'email_typo', points: pts, detail: `Same domain, local parts ${d} edit(s) apart ("${ea.local}" ~ "${eb.local}") — likely typo` });
      return pts;
    }
    if (ea.local === eb.local) { // same local, same domain handled above; this is unreachable, kept for clarity
      return 0;
    }
    reasons.push({ signal: 'email_same_domain', points: 4, detail: `Same email domain (${ea.domain}) only` });
    return 4;
  }
  if (ea.local === eb.local) {
    reasons.push({ signal: 'email_same_local', points: 10, detail: `Same email local part on different domains ("${ea.local}")` });
    return 10;
  }
  return 0;
}

function phoneScore(a, b, reasons) {
  const pa = normalizePhone(props(a).phone || props(a).mobilephone);
  const pb = normalizePhone(props(b).phone || props(b).mobilephone);
  if (!pa.digits || !pb.digits || pa.digits.length < 7 || pb.digits.length < 7) return 0;
  if (pa.national && pa.national === pb.national) {
    reasons.push({ signal: 'phone_exact', points: 30, detail: `Identical phone (${pa.national})` });
    return 30;
  }
  if (pa.last10 && pa.last10 === pb.last10) {
    reasons.push({ signal: 'phone_last10', points: 24, detail: `Phones match on last 10 digits` });
    return 24;
  }
  return 0;
}

function companyAssocScore(a, b, reasons) {
  const ca = normalizeText(props(a).company || '');
  const cb = normalizeText(props(b).company || '');
  if (ca && cb && ca === cb) {
    reasons.push({ signal: 'company_same', points: 8, detail: `Same associated company name ("${ca}")` });
    return 8;
  }
  return 0;
}

function scoreContactPair(a, b) {
  const reasons = [];
  let score = 0;
  score += nameScore(a, b, reasons);
  score += emailScore(a, b, reasons);
  score += phoneScore(a, b, reasons);
  score += companyAssocScore(a, b, reasons);
  score = Math.min(100, score);
  return { score, caution: score >= CAUTION_THRESHOLD && score < PROPOSE_THRESHOLD, reasons };
}

/* ---------------- company signals ---------------- */

function scoreCompanyPair(a, b) {
  const reasons = [];
  let score = 0;
  const da = normalizeDomain(props(a).domain || '');
  const db = normalizeDomain(props(b).domain || '');
  if (da && db && da === db) {
    reasons.push({ signal: 'domain_exact', points: 60, detail: `Identical domain (${da})` });
    score += 60;
  }
  const na = normalizeText(props(a).name || '');
  const nb = normalizeText(props(b).name || '');
  if (na && nb) {
    if (na === nb) {
      reasons.push({ signal: 'company_name_exact', points: 25, detail: `Identical company name ("${na}")` });
      score += 25;
    } else {
      // strip common legal suffixes before comparing
      const strip = (s) => s.replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh|pty)\b/g, '').replace(/\s+/g, ' ').trim();
      if (strip(na) && strip(na) === strip(nb)) {
        reasons.push({ signal: 'company_name_suffix_variant', points: 20, detail: `Company names match ignoring legal suffixes` });
        score += 20;
      } else if (soundex(na.replace(/\s/g, '')) === soundex(nb.replace(/\s/g, ''))) {
        reasons.push({ signal: 'company_name_phonetic', points: 12, detail: `Company names phonetically similar` });
        score += 12;
      }
    }
  }
  score += phoneScore(a, b, reasons);
  score = Math.min(100, score);
  return { score, caution: score >= CAUTION_THRESHOLD && score < PROPOSE_THRESHOLD, reasons };
}

/* ---------------- candidate generation + scan ---------------- */

/*
 * Blocking keys: two records become a candidate pair if they share any
 * key. Keys are cheap, high-recall signals; scoring does the precision.
 */
function blockKeys(rec, objectType) {
  const p = props(rec);
  const keys = new Set();
  if (objectType === 'contacts') {
    const e = normalizeEmail(p.email);
    if (e.domain) keys.add(`edom:${e.domain}`);
    if (e.canonical) keys.add(`ecan:${e.canonical}`);
    const ph = normalizePhone(p.phone || p.mobilephone);
    if (ph.last10) keys.add(`ph:${ph.last10}`);
    const n = splitName(p.firstname, p.lastname, p.name);
    if (n.last) keys.add(`ln:${soundex(n.last)}`);
  } else {
    const d = normalizeDomain(p.domain || '');
    if (d) keys.add(`dom:${d}`);
    const nm = normalizeText(p.name || '');
    if (nm) keys.add(`cn:${soundex(nm.replace(/\s/g, ''))}`);
  }
  return [...keys];
}

/**
 * Find duplicate pairs in a list of records.
 * Returns [{ aId, bId, score, caution, reasons }] sorted by score desc.
 * Only pairs at or above the caution threshold are returned.
 */
function findDuplicates(records, objectType) {
  const scoreFn = objectType === 'companies' ? scoreCompanyPair : scoreContactPair;
  const blocks = new Map();
  for (const rec of records) {
    for (const key of blockKeys(rec, objectType)) {
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(rec);
    }
  }
  const seen = new Set();
  const out = [];
  for (const group of blocks.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [x, y] = group[i].id < group[j].id ? [group[i], group[j]] : [group[j], group[i]];
        const pairKey = `${x.id}:${y.id}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const { score, caution, reasons } = scoreFn(x, y);
        if (score >= CAUTION_THRESHOLD) out.push({ aId: x.id, bId: y.id, score, caution, reasons });
      }
    }
  }
  out.sort((p, q) => q.score - p.score);
  return out;
}

module.exports = {
  PROPOSE_THRESHOLD, CAUTION_THRESHOLD,
  scoreContactPair, scoreCompanyPair, findDuplicates, blockKeys,
};
