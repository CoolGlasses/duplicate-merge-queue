'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StripeClient, applyStripeEvent } = require('../src/stripe');
const { Store } = require('../src/store');
const { fixtureTransport } = require('./fixtures');

const SECRET = 'whsec_test_123';
const env = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_ID_PORTAL: 'price_123' };

function sign(payload, secret, ts = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

test('webhook signature: valid passes; tampered payload and wrong secret fail', () => {
  const stripe = new StripeClient(env);
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
  const header = sign(payload, SECRET);
  assert.equal(stripe.verifyWebhookSignature(payload, header), true);
  assert.equal(stripe.verifyWebhookSignature(payload.replace('evt_1', 'evt_2'), header), false, 'tampered payload');
  assert.equal(stripe.verifyWebhookSignature(payload, sign(payload, 'whsec_other')), false, 'wrong secret');
  assert.equal(stripe.verifyWebhookSignature(payload, 'garbage'), false);
  assert.equal(stripe.verifyWebhookSignature(payload, ''), false);
  assert.deepEqual(stripe.constructEvent(payload, header).id, 'evt_1');
  assert.throws(() => stripe.constructEvent(payload, sign(payload, 'nope')), /invalid Stripe webhook signature/);
});

test('webhook signature: stale timestamp rejected (replay guard)', () => {
  const stripe = new StripeClient(env);
  const payload = '{"id":"evt_1","type":"x","data":{"object":{}}}';
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(stripe.verifyWebhookSignature(payload, sign(payload, SECRET, old)), false);
});

test('not configured: flags false, checkout refuses cleanly, webhook verify false', async () => {
  const stripe = new StripeClient({});
  assert.equal(stripe.configured, false);
  assert.equal(stripe.webhookConfigured, false);
  await assert.rejects(
    () => stripe.createCheckoutSession({ portalId: 'P', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' }),
    (err) => err.code === 'BILLING_NOT_CONFIGURED',
  );
  assert.equal(stripe.verifyWebhookSignature('{}', 't=1,v1=abc'), false);
});

test('checkout session: posts subscription mode with the portal price + reference', async () => {
  const transport = fixtureTransport([
    [({ url }) => url.includes('/v1/checkout/sessions'), { id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }],
  ]);
  const stripe = new StripeClient(env, transport);
  const session = await stripe.createCheckoutSession({ portalId: 'P42', successUrl: 'https://app/ok', cancelUrl: 'https://app/no' });
  assert.equal(session.url, 'https://checkout.stripe.com/pay/cs_1');
  const form = new URLSearchParams(transport.calls[0].body);
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('line_items[0][price]'), 'price_123');
  assert.equal(form.get('client_reference_id'), 'P42');
  assert.equal(transport.calls[0].headers.Authorization, 'Bearer sk_test_x');
});

test('applyStripeEvent: checkout completes -> paid; subscription deleted -> free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmq-stripe-'));
  const store = new Store(path.join(dir, 'store.json'));
  store.upsertPortal('P42', {});
  const r1 = applyStripeEvent(store, {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', client_reference_id: 'P42' } },
  });
  assert.deepEqual(r1, { portalId: 'P42', plan: 'paid' });
  assert.equal(store.getPortal('P42').plan, 'paid');
  const r2 = applyStripeEvent(store, {
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', metadata: { portalId: 'P42' } } },
  });
  assert.deepEqual(r2, { portalId: 'P42', plan: 'free' });
  assert.equal(store.getPortal('P42').plan, 'free');
  assert.equal(applyStripeEvent(store, { type: 'payment_intent.created', data: { object: {} } }), null);
  assert.ok(store.listAudit('P42').length >= 2);
});
