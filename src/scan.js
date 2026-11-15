'use strict';
/*
 * Portal scanning. Fetches contacts + companies through the HubSpot
 * client, stores the records, runs the matching engine, and upserts
 * proposals. Incremental mode (the sweep) restricts NEW proposals to
 * pairs involving a record changed since the portal's last scan — the
 * list itself is still fetched in full in v1 (portals in our band are
 * small; the Search API is the optimisation if that stops being true).
 */
const { findDuplicates } = require('./matching');

const CONTACT_PROPERTIES = ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company', 'jobtitle', 'website', 'address', 'city', 'state', 'zip', 'country'];
const COMPANY_PROPERTIES = ['name', 'domain', 'phone', 'website', 'industry', 'address', 'city', 'state', 'zip', 'country', 'numberofemployees'];

/** Ensure a fresh access token; refreshes and re-seals when expired. */
async function freshTokens({ client, vault, store, portal }) {
  let bundle = vault.unseal(portal.tokens);
  if (!bundle) throw new Error(`portal ${portal.portalId} has no stored tokens`);
  const expiresAt = Date.parse(bundle.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 60_000) {
    const res = await client.refreshTokens(bundle.refreshToken);
    bundle = {
      accessToken: res.access_token,
      refreshToken: res.refresh_token || bundle.refreshToken,
      expiresAt: new Date(Date.now() + (res.expires_in || 1800) * 1000).toISOString(),
    };
    store.upsertPortal(portal.portalId, { tokens: vault.seal(bundle) });
  }
  return bundle;
}

async function scanPortal({ client, vault, store, portalId, incremental = false }) {
  const portal = store.getPortal(portalId);
  if (!portal) throw new Error(`unknown portal ${portalId}`);
  const bundle = await freshTokens({ client, vault, store, portal });
  const sinceMs = incremental && portal.lastScanAt ? Date.parse(portal.lastScanAt) : 0;
  const summary = { portalId, contacts: 0, companies: 0, proposalsCreated: 0, proposalsSeen: 0 };

  for (const [objectType, properties] of [['contacts', CONTACT_PROPERTIES], ['companies', COMPANY_PROPERTIES]]) {
    const records = await client.listAllObjects(bundle.accessToken, objectType, { properties });
    const changed = new Set();
    for (const rec of records) {
      store.upsertRecord(portalId, objectType, rec);
      const upd = Date.parse(rec.updatedAt || '') || 0;
      if (!incremental || upd > sinceMs) changed.add(String(rec.id));
    }
    summary[objectType] = records.length;
    const pairs = findDuplicates(records, objectType);
    for (const pair of pairs) {
      if (incremental && !changed.has(String(pair.aId)) && !changed.has(String(pair.bId))) continue;
      summary.proposalsSeen++;
      const { created } = store.upsertProposal({
        portalId, objectType, aId: pair.aId, bId: pair.bId,
        score: pair.score, caution: pair.caution, reasons: pair.reasons,
      });
      if (created) summary.proposalsCreated++;
    }
  }

  store.upsertPortal(portalId, {
    lastScanAt: new Date().toISOString(),
    ...(incremental ? {} : { lastFullScanAt: new Date().toISOString() }),
  });
  store.appendAudit({ portalId, actor: 'scanner', action: incremental ? 'scan_incremental' : 'scan_full', detail: JSON.stringify(summary) });
  return summary;
}

module.exports = { scanPortal, freshTokens, CONTACT_PROPERTIES, COMPANY_PROPERTIES };
