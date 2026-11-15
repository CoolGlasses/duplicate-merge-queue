'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { TokenVault } = require('../src/tokens');
const { HubSpotClient } = require('../src/hubspot');
const { scanPortal } = require('../src/scan');
const { fixtureTransport, contact, company } = require('./fixtures');

function portalFixture({ expiredToken = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmq-scan-'));
  const store = new Store(path.join(dir, 'store.json'));
  const vault = new TokenVault({}, () => {});
  const bundle = {
    accessToken: 'AT_OLD', refreshToken: 'RT1',
    expiresAt: expiredToken ? new Date(Date.now() - 1000).toISOString() : new Date(Date.now() + 3600e3).toISOString(),
  };
  store.upsertPortal('777', { tokens: vault.seal(bundle) });
  const transport = fixtureTransport([
    [({ url }) => url.endsWith('/oauth/v1/token'), { access_token: 'AT_NEW', refresh_token: 'RT2', expires_in: 1800 }],
    [({ url }) => url.includes('/crm/v3/objects/contacts'), {
      results: [
        contact(1, { firstname: 'Jon', lastname: 'Smith', email: 'jon.smith@acme.com', phone: '5550102233' }),
        contact(2, { firstname: 'John', lastname: 'Smith', email: 'john.smith@acme.com', phone: '+1 555 010 2233' }),
        contact(3, { firstname: 'Solo', lastname: 'Unique', email: 'solo@unique.io', phone: '5551112222' }),
      ],
    }],
    [({ url }) => url.includes('/crm/v3/objects/companies'), {
      results: [
        company(10, { name: 'Acme Inc', domain: 'acme.com' }),
        company(11, { name: 'Acme', domain: 'acme.com' }),
      ],
    }],
    [({ url }) => url.includes('/merge'), { id: '1' }],
  ]);
  const client = new HubSpotClient({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://x/cb', transport });
  return { store, vault, client, transport };
}

test('scan: full scan stores records, creates proposals for both object types', async () => {
  const { store, vault, client } = portalFixture();
  const summary = await scanPortal({ client, vault, store, portalId: '777', incremental: false });
  assert.equal(summary.contacts, 3);
  assert.equal(summary.companies, 2);
  const pending = store.listProposals('777', 'pending');
  assert.equal(pending.length, 2, 'one contact pair + one company pair');
  assert.ok(pending.every((p) => p.score >= 60 && p.reasons.length > 0));
  assert.ok(store.getPortal('777').lastScanAt);
  assert.ok(store.getPortal('777').lastFullScanAt);
  assert.equal(store.listRecords('777', 'contacts').length, 3);
});

test('scan: incremental re-scan creates no duplicates', async () => {
  const { store, vault, client } = portalFixture();
  await scanPortal({ client, vault, store, portalId: '777', incremental: false });
  const again = await scanPortal({ client, vault, store, portalId: '777', incremental: true });
  assert.equal(again.proposalsCreated, 0);
  assert.equal(store.listProposals('777').length, 2);
});

test('scan: expired access token is refreshed and re-sealed', async () => {
  const { store, vault, client, transport } = portalFixture({ expiredToken: true });
  await scanPortal({ client, vault, store, portalId: '777', incremental: false });
  const tokenCalls = transport.calls.filter((c) => c.url.endsWith('/oauth/v1/token'));
  assert.equal(tokenCalls.length, 1);
  assert.ok(tokenCalls[0].body.includes('grant_type=refresh_token'));
  const bundle = vault.unseal(store.getPortal('777').tokens);
  assert.equal(bundle.accessToken, 'AT_NEW');
  const listCall = transport.calls.find((c) => c.url.includes('/crm/v3/objects/contacts'));
  assert.equal(listCall.headers.Authorization, 'Bearer AT_NEW');
});
