'use strict';
/*
 * Stripe billing, vendor-side. Stripe is called through an injectable
 * transport (same shape as the HubSpot client). Webhook signature
 * verification is implemented manually (HMAC-SHA256 over
 * "<timestamp>.<payload>", per Stripe's scheme) — no SDK, no deps.
 *
 * If STRIPE_SECRET_KEY is absent the module reports "not configured"
 * and the app runs in free mode; nothing here throws on missing config.
 */
const crypto = require('crypto');

async function fetchTransport({ method, url, headers, body }) {
  const res = await fetch(url, { method, headers, body });
  return { status: res.status, body: await res.text() };
}

class StripeClient {
  constructor(env, transport) {
    env = env || {};
    this.secretKey = env.STRIPE_SECRET_KEY || '';
    this.webhookSecret = env.STRIPE_WEBHOOK_SECRET || '';
    this.priceId = env.STRIPE_PRICE_ID_PORTAL || '';
    this.transport = transport || fetchTransport;
  }

  get configured() { return Boolean(this.secretKey); }
  get webhookConfigured() { return Boolean(this.webhookSecret); }

  async createCheckoutSession({ portalId, successUrl, cancelUrl }) {
    if (!this.configured) {
      const err = new Error('billing not configured');
      err.code = 'BILLING_NOT_CONFIGURED';
      throw err;
    }
    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': this.priceId,
      'line_items[0][quantity]': '1',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(portalId),
      'metadata[portalId]': String(portalId),
      'subscription_data[metadata][portalId]': String(portalId),
    });
    const res = await this.transport({
      method: 'POST',
      url: 'https://api.stripe.com/v1/checkout/sessions',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch (_) { /* keep null */ }
    if (res.status >= 400 || !parsed || !parsed.url) {
      throw new Error(`Stripe checkout session failed (${res.status}): ${String(res.body).slice(0, 200)}`);
    }
    return parsed;
  }

  /**
   * Verify a Stripe-Signature header against the raw payload.
   * Returns true/false, never throws. toleranceSec guards replays.
   */
  verifyWebhookSignature(rawPayload, signatureHeader, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
    if (!this.webhookConfigured) return false;
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    let timestamp = null;
    const v1s = [];
    for (const part of signatureHeader.split(',')) {
      const [k, v] = part.split('=', 2);
      if (k === 't') timestamp = v;
      else if (k === 'v1') v1s.push(v);
    }
    if (!timestamp || v1s.length === 0) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawPayload}`)
      .digest('hex');
    const expBuf = Buffer.from(expected);
    return v1s.some((v1) => {
      const b = Buffer.from(String(v1));
      return b.length === expBuf.length && crypto.timingSafeEqual(b, expBuf);
    });
  }

  /** Verify + parse a webhook delivery. Throws on bad signature. */
  constructEvent(rawPayload, signatureHeader) {
    if (!this.verifyWebhookSignature(rawPayload, signatureHeader)) {
      throw new Error('invalid Stripe webhook signature');
    }
    return JSON.parse(rawPayload);
  }
}

/**
 * Apply a Stripe event to portal plan state. Returns a description of
 * the change, or null when the event doesn't affect plans.
 */
function applyStripeEvent(store, event) {
  if (!event || !event.type) return null;
  const obj = (event.data && event.data.object) || {};
  const portalId = obj.client_reference_id || (obj.metadata && obj.metadata.portalId) || null;
  switch (event.type) {
    case 'checkout.session.completed': {
      if (!portalId) return null;
      store.setPlan(portalId, 'paid');
      store.appendAudit({ portalId, actor: 'stripe', action: 'plan_paid', detail: `checkout.session.completed ${obj.id || ''}`.trim() });
      return { portalId, plan: 'paid' };
    }
    case 'customer.subscription.deleted': {
      if (!portalId) return null;
      store.setPlan(portalId, 'free');
      store.appendAudit({ portalId, actor: 'stripe', action: 'plan_free', detail: `subscription deleted ${obj.id || ''}`.trim() });
      return { portalId, plan: 'free' };
    }
    case 'customer.subscription.updated': {
      if (!portalId) return null;
      const plan = obj.status === 'active' || obj.status === 'trialing' ? 'paid' : 'free';
      store.setPlan(portalId, plan);
      store.appendAudit({ portalId, actor: 'stripe', action: 'plan_updated', detail: `subscription ${obj.id || ''} status ${obj.status}` });
      return { portalId, plan };
    }
    default:
      return null;
  }
}

module.exports = { StripeClient, applyStripeEvent };
