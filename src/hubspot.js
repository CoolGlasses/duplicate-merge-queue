'use strict';
/*
 * HubSpot API client. All HTTP goes through an injectable transport:
 *   transport({ method, url, headers, body }) -> Promise<{ status, body }>
 * where body in/out are strings. Production uses fetch; tests use
 * fixtures. Endpoint shapes follow HubSpot's public API documentation
 * (flagged in the README as assumptions to verify live).
 */

const API_BASE = 'https://api.hubapi.com';

const DEFAULT_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'oauth',
];

async function fetchTransport({ method, url, headers, body }) {
  const res = await fetch(url, { method, headers, body });
  return { status: res.status, body: await res.text() };
}

class HubSpotError extends Error {
  constructor(status, body, context) {
    super(`HubSpot API error ${status}${context ? ` (${context})` : ''}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

class HubSpotClient {
  constructor({ clientId, clientSecret, redirectUri, transport, apiBase } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.transport = transport || fetchTransport;
    this.apiBase = apiBase || API_BASE;
  }

  async request(method, pathOrUrl, { token, form, json } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.apiBase + pathOrUrl;
    const headers = {};
    let body;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await this.transport({ method, url, headers, body });
    let parsed = null;
    try { parsed = res.body ? JSON.parse(res.body) : null; } catch (_) { parsed = null; }
    if (res.status >= 400) throw new HubSpotError(res.status, res.body, `${method} ${url}`);
    return parsed;
  }

  /* -------- OAuth -------- */

  authorizeUrl(state, scopes) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: (scopes || DEFAULT_SCOPES).join(' '),
      state,
    });
    return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code) {
    return this.request('POST', '/oauth/v1/token', {
      form: {
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        code,
      },
    });
  }

  async refreshTokens(refreshToken) {
    return this.request('POST', '/oauth/v1/token', {
      form: {
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      },
    });
  }

  /** Token metadata, including hub_id (the portal id). */
  async getAccessTokenInfo(accessToken) {
    return this.request('GET', `/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`);
  }

  /* -------- CRM reads -------- */

  async listObjects(accessToken, objectType, { properties, limit = 100, after } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set('after', after);
    if (properties && properties.length) params.set('properties', properties.join(','));
    return this.request('GET', `/crm/v3/objects/${objectType}?${params.toString()}`, { token: accessToken });
  }

  /** Follow pagination to the end; returns a flat array of records. */
  async listAllObjects(accessToken, objectType, { properties, pageLimit = 100, maxPages = 200 } = {}) {
    const out = [];
    let after;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.listObjects(accessToken, objectType, { properties, limit: pageLimit, after });
      for (const r of res.results || []) out.push(r);
      after = res.paging && res.paging.next && res.paging.next.after;
      if (!after) break;
    }
    return out;
  }

  async getObject(accessToken, objectType, id, { properties } = {}) {
    const qs = properties && properties.length ? `?properties=${properties.join(',')}` : '';
    return this.request('GET', `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}${qs}`, { token: accessToken });
  }

  async batchRead(accessToken, objectType, ids, { properties } = {}) {
    return this.request('POST', `/crm/v3/objects/${objectType}/batch/read`, {
      token: accessToken,
      json: { inputs: ids.map((id) => ({ id: String(id) })), properties: properties || [] },
    });
  }

  /* -------- Merge -------- */

  /** POST /crm/v3/objects/{objectType}/merge — primary survives, other is merged into it. */
  async mergeObjects(accessToken, objectType, primaryId, objectIdToMerge) {
    return this.request('POST', `/crm/v3/objects/${objectType}/merge`, {
      token: accessToken,
      json: { primaryObjectId: String(primaryId), objectIdToMerge: String(objectIdToMerge) },
    });
  }
}

/* -------- OAuth state (CSRF) handling -------- */

const crypto = require('crypto');

/** Create a signed, expiring state token. secret: SESSION_SECRET. */
function createOAuthState(secret, ttlMs = 10 * 60 * 1000, now = Date.now()) {
  const payload = { exp: now + ttlMs, nonce: crypto.randomBytes(12).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', String(secret || '')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify signature + expiry. Returns true/false, never throws. */
function verifyOAuthState(state, secret, now = Date.now()) {
  try {
    if (!state || typeof state !== 'string') return false;
    const [body, sig] = state.split('.');
    if (!body || !sig) return false;
    const expected = crypto.createHmac('sha256', String(secret || '')).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > now;
  } catch (_) {
    return false;
  }
}

module.exports = { HubSpotClient, HubSpotError, DEFAULT_SCOPES, createOAuthState, verifyOAuthState };
