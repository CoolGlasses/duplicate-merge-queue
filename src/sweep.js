'use strict';
/*
 * Scheduler entrypoint (cron): incremental re-scan of every connected
 * portal. Cron example: run every 6 hours —
 *   minute 0, every 6th hour, cd to the app dir && node src/sweep.js
 */
const path = require('path');
const { Store } = require('./store');
const { TokenVault } = require('./tokens');
const { HubSpotClient } = require('./hubspot');
const { scanPortal } = require('./scan');
const { loadDotEnv } = require('./env');

async function main() {
  loadDotEnv();
  const store = new Store(path.join(__dirname, '..', 'data', 'store.json'));
  const vault = new TokenVault(process.env);
  const client = new HubSpotClient({
    clientId: process.env.HUBSPOT_CLIENT_ID,
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
    redirectUri: process.env.HUBSPOT_REDIRECT_URI,
  });
  const portals = store.listPortals().filter((p) => p.tokens);
  if (!portals.length) { console.log('sweep: no connected portals'); return; }
  for (const portal of portals) {
    try {
      const summary = await scanPortal({ client, vault, store, portalId: portal.portalId, incremental: true });
      console.log(`sweep: portal ${portal.portalId}: ${JSON.stringify(summary)}`);
    } catch (err) {
      console.error(`sweep: portal ${portal.portalId} failed: ${err.message || err}`);
      store.appendAudit({ portalId: portal.portalId, actor: 'scanner', action: 'scan_failed', detail: String(err.message || err) });
    }
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { main };
