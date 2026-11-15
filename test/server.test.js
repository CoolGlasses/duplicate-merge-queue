'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { Store } = require('../src/store');
const { TokenVault } = require('../src/tokens');
const { hashPassword } = require('../src/auth');
const { fixtureTransport, contact } = require('./fixtures');

async function startApp(t, { stripeEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmq-srv-'));
  const store = new Store(path.join(dir, 'store.json'));
  const vault = new TokenVault({}, () => {});
  const hubspotTransport = fixtureTransport([
    [({ url }) => url.includes('/merge'), ({ body }) => ({ id: JSON.parse(body).primaryObjectId })],
    [({ url }) => url.endsWith('/oauth/v1/token'), { access_token: 'AT', refresh_token: 'RT', expires_in: 1800 }],
  ]);
  const env = {
    SESSION_SECRET: 'test-session-secret',
    OPERATOR_PASSWORD_HASH: hashPassword('hunter2'),
    HUBSPOT_CLIENT_ID: 'cid', HUBSPOT_CLIENT_SECRET: 'sec',
    HUBSPOT_REDIRECT_URI: 'http://localhost/oauth/callback',
    ...stripeEnv,
  };
  const app = createApp(env, { store, vault, hubspotTransport, logger: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, store, vault, hubspotTransport };
}

async function login(base) {
  const res = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=hunter2',
  });
  assert.equal(res.status, 302);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie && cookie.includes('dmq_session='));
  return cookie.split(';')[0];
}

function seedPortal(store, vault, plan = 'free') {
  store.upsertPortal('777', {
    plan,
    tokens: vault.seal({ accessToken: 'AT', refreshToken: 'RT', expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
  });
  const a = contact(1, { firstname: 'Jon', lastname: 'Smith', email: 'jon.smith@acme.com', phone: '5550102233' });
  const b = contact(2, { firstname: 'John', lastname: 'Smith', email: 'john.smith@acme.com', phone: '5550102233', company: 'Acme' });
  store.upsertRecord('777', 'contacts', a);
  store.upsertRecord('777', 'contacts', b);
  const { proposal } = store.upsertProposal({
    portalId: '777', objectType: 'contacts', aId: '1', bId: '2', score: 90, caution: false,
    reasons: [{ signal: 'phone_exact', points: 30, detail: 'Identical phone' }],
  });
  return proposal;
}

test('server: health open, queue requires login, wrong password rejected', async (t) => {
  const { base } = await startApp(t);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).billingConfigured, false);

  const queue = await fetch(`${base}/queue`, { redirect: 'manual' });
  assert.equal(queue.status, 302);
  assert.equal(queue.headers.get('location'), '/login');

  const bad = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=wrong',
  });
  assert.equal(bad.status, 401);
});

test('server: free plan sees the COUNT only; approve is refused; checkout says not configured', async (t) => {
  const { base, store, vault } = await startApp(t);
  const proposal = seedPortal(store, vault, 'free');
  const cookie = await login(base);

  const page = await (await fetch(`${base}/queue`, { headers: { Cookie: cookie } })).text();
  assert.match(page, /1 duplicate pair/);
  assert.match(page, /free tier shows the count/i);
  assert.ok(!page.includes('Approve merge'), 'free tier must not render merge controls');

  const approve = await fetch(`${base}/proposals/${proposal.id}/approve`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(approve.status, 403);

  const checkout = await fetch(`${base}/billing/checkout`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(checkout.status, 503);
  assert.match((await checkout.json()).error, /not configured/);
});

test('server: paid approve snapshots FIRST, then merges, audits both', async (t) => {
  const { base, store, vault, hubspotTransport } = await startApp(t);
  const proposal = seedPortal(store, vault, 'paid');
  const cookie = await login(base);

  const page = await (await fetch(`${base}/queue`, { headers: { Cookie: cookie } })).text();
  assert.ok(page.includes('Approve merge'));
  assert.ok(page.includes('Identical phone'), 'score explanations are rendered');

  const res = await fetch(`${base}/proposals/${proposal.id}/approve`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(res.status, 302);

  const mergeCalls = hubspotTransport.calls.filter((c) => c.url.includes('/merge'));
  assert.equal(mergeCalls.length, 1);
  // Record 2 is more complete (has company) -> it survives; 1 merges into it.
  assert.deepEqual(JSON.parse(mergeCalls[0].body), { primaryObjectId: '2', objectIdToMerge: '1' });

  const after = store.getProposal(proposal.id);
  assert.equal(after.status, 'merged');
  assert.ok(after.snapshotId, 'snapshot id recorded on the proposal');
  const snap = store.getSnapshot(after.snapshotId);
  assert.equal(snap.primaryId, '2');
  assert.equal(snap.secondary.properties.email, 'jon.smith@acme.com');

  const actions = store.listAudit('777').map((e) => e.action);
  assert.ok(actions.includes('snapshot_saved'));
  assert.ok(actions.includes('merge_executed'));
  assert.ok(actions.indexOf('snapshot_saved') < actions.indexOf('merge_executed'), 'snapshot precedes merge');
});

test('server: dismiss records the reason; snooze parks the pair', async (t) => {
  const { base, store, vault } = await startApp(t);
  const proposal = seedPortal(store, vault, 'paid');
  const cookie = await login(base);
  const dismiss = await fetch(`${base}/proposals/${proposal.id}/dismiss`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'reason=' + encodeURIComponent('different people, shared office line'),
  });
  assert.equal(dismiss.status, 302);
  const after = store.getProposal(proposal.id);
  assert.equal(after.status, 'dismissed');
  assert.equal(after.dismissReason, 'different people, shared office line');

  const { proposal: p2 } = store.upsertProposal({
    portalId: '777', objectType: 'contacts', aId: '1', bId: '3', score: 65, caution: true, reasons: [],
  });
  const snooze = await fetch(`${base}/proposals/${p2.id}/snooze`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(snooze.status, 302);
  assert.equal(store.getProposal(p2.id).status, 'snoozed');
});

test('server: stripe webhook flips the plan only with a valid signature', async (t) => {
  const stripeEnv = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_srv', STRIPE_PRICE_ID_PORTAL: 'price_1' };
  const { base, store, vault } = await startApp(t, { stripeEnv });
  seedPortal(store, vault, 'free');
  const payload = JSON.stringify({
    id: 'evt_9', type: 'checkout.session.completed',
    data: { object: { id: 'cs_9', client_reference_id: '777' } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', 'whsec_srv').update(`${ts}.${payload}`).digest('hex');

  const bad = await fetch(`${base}/billing/webhook`, {
    method: 'POST', headers: { 'Stripe-Signature': `t=${ts},v1=${'0'.repeat(64)}` }, body: payload,
  });
  assert.equal(bad.status, 400);
  assert.equal(store.getPortal('777').plan, 'free');

  const good = await fetch(`${base}/billing/webhook`, {
    method: 'POST', headers: { 'Stripe-Signature': `t=${ts},v1=${v1}` }, body: payload,
  });
  assert.equal(good.status, 200);
  assert.equal(store.getPortal('777').plan, 'paid');
});
