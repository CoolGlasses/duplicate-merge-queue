'use strict';
/*
 * Merge planning — pure functions. NOTHING here calls HubSpot: the plan
 * (snapshot + API payload) is built and persisted first, and only then
 * does the caller execute it. The snapshot is the audit/undo record:
 * after a merge, HubSpot cannot un-merge, so the snapshot is the only
 * way back (manual recreation from the snapshot data).
 */
const crypto = require('crypto');

const CONTACT_FIELDS = ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company', 'jobtitle', 'website', 'address', 'city', 'state', 'zip', 'country'];
const COMPANY_FIELDS = ['name', 'domain', 'phone', 'website', 'industry', 'address', 'city', 'state', 'zip', 'country', 'numberofemployees'];

/** Completeness = number of non-empty known fields (plus any extras). */
function completeness(record, objectType) {
  const p = (record && record.properties) || {};
  const known = objectType === 'companies' ? COMPANY_FIELDS : CONTACT_FIELDS;
  let n = 0;
  for (const f of known) {
    const v = p[f];
    if (v !== undefined && v !== null && String(v).trim() !== '') n++;
  }
  return n;
}

function updatedMs(record) {
  const t = Date.parse((record && (record.updatedAt || record.properties?.hs_lastmodifieddate)) || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Default survivor: the most complete record; ties broken by most
 * recently updated; final tie broken by the smaller id (deterministic).
 * Returns { survivor, merged }.
 */
function chooseSurvivor(a, b, objectType) {
  const ca = completeness(a, objectType);
  const cb = completeness(b, objectType);
  if (ca !== cb) return ca > cb ? { survivor: a, merged: b } : { survivor: b, merged: a };
  const ua = updatedMs(a);
  const ub = updatedMs(b);
  if (ua !== ub) return ua > ub ? { survivor: a, merged: b } : { survivor: b, merged: a };
  return String(a.id) <= String(b.id) ? { survivor: a, merged: b } : { survivor: b, merged: a };
}

/** Deep-copied pre-merge snapshot of BOTH records. */
function buildSnapshot({ portalId, objectType, primary, secondary, takenBy, at }) {
  return {
    id: `snap_${crypto.randomBytes(8).toString('hex')}`,
    portalId,
    objectType,
    primaryId: String(primary.id),
    secondaryId: String(secondary.id),
    primary: JSON.parse(JSON.stringify(primary)),
    secondary: JSON.parse(JSON.stringify(secondary)),
    takenBy: takenBy || 'operator',
    takenAt: at || new Date().toISOString(),
  };
}

/** The HubSpot merge API payload: primary survives. */
function buildMergePayload(primaryId, objectIdToMerge) {
  return { primaryObjectId: String(primaryId), objectIdToMerge: String(objectIdToMerge) };
}

/**
 * Full plan for an approved proposal.
 * survivorId (optional) — the operator's explicit choice; default is
 * chooseSurvivor(). Returns { survivorId, mergedId, snapshot, payload }.
 */
function planMerge({ portalId, objectType, recordA, recordB, survivorId, takenBy, at }) {
  let survivor;
  let merged;
  if (survivorId && String(survivorId) === String(recordA.id)) { survivor = recordA; merged = recordB; }
  else if (survivorId && String(survivorId) === String(recordB.id)) { survivor = recordB; merged = recordA; }
  else ({ survivor, merged } = chooseSurvivor(recordA, recordB, objectType));
  const snapshot = buildSnapshot({ portalId, objectType, primary: survivor, secondary: merged, takenBy, at });
  const payload = buildMergePayload(survivor.id, merged.id);
  return { survivorId: String(survivor.id), mergedId: String(merged.id), snapshot, payload };
}

module.exports = { completeness, chooseSurvivor, buildSnapshot, buildMergePayload, planMerge, CONTACT_FIELDS, COMPANY_FIELDS };
