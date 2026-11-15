'use strict';
/*
 * Duplicate Merge Queue — web server.
 *
 * Routes:
 *   GET  /health                  liveness + billing-configured flag
 *   GET  /login, POST /login      operator session login
 *   POST /logout
 *   GET  /oauth/authorize         start HubSpot OAuth (state-signed)
 *   GET  /oauth/callback          code exchange -> portal connect + full scan
 *   GET  /queue                   review UI (plan-gated: free = count only)
 *   POST /proposals/:id/approve   snapshot -> merge -> audit (paid only)
 *   POST /proposals/:id/dismiss   with reason
 *   POST /proposals/:id/snooze
 *   POST /scan/run                trigger a scan for the connected portal
 *   POST /billing/checkout        Stripe Checkout for the $29/mo portal plan
 *   POST /billing/webhook         Stripe webhook (signature verified)
 *   GET  /api/status              JSON counts
 *
 * Auth: everything except /health, /login, /oauth/* and the Stripe
 * webhook requires the operator session cookie.
 */
const http = require('http');
const path = require('path');
const { Store } = require('./store');
const { TokenVault } = require('./tokens');
const { HubSpotClient, createOAuthState, verifyOAuthState } = require('./hubspot');
const { StripeClient, applyStripeEvent } = require('./stripe');
const { verifyPassword, signSession, verifySession, parseCookies } = require('./auth');
const { planMerge } = require('./merge');
const { scanPortal, freshTokens } = require('./scan');
const { loadDotEnv } = require('./env');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createApp(env, deps = {}) {
  const store = deps.store || new Store(path.join(__dirname, '..', 'data', 'store.json'));
  const vault = deps.vault || new TokenVault(env, deps.logger);
  const hubspot = deps.hubspot || new HubSpotClient({
    clientId: env.HUBSPOT_CLIENT_ID,
    clientSecret: env.HUBSPOT_CLIENT_SECRET,
    redirectUri: env.HUBSPOT_REDIRECT_URI,
    transport: deps.hubspotTransport,
  });
  const stripe = deps.stripe || new StripeClient(env, deps.stripeTransport);
  const sessionSecret = env.SESSION_SECRET || '';
  const passwordHash = env.OPERATOR_PASSWORD_HASH || '';

  function authed(req) {
    const cookies = parseCookies(req.headers.cookie);
    return verifySession(cookies.dmq_session, sessionSecret);
  }

  function send(res, status, body, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  }
  function json(res, status, obj) { send(res, status, JSON.stringify(obj), 'application/json'); }
  function redirect(res, location, extraHeaders = {}) {
    res.writeHead(302, { Location: location, ...extraHeaders });
    res.end();
  }

  function currentPortal() {
    const portals = store.listPortals();
    return portals.length ? portals[0] : null;
  }

  /* ---------- HTML ---------- */

  function pageShell(title, inner) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Duplicate Merge Queue</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:1000px;padding:0 1rem;color:#1c2b33}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #dfe3e6;padding:.4rem .6rem;text-align:left;vertical-align:top}
.diff{background:#fff3cd}.score{font-weight:700}.caution{color:#9a6700}.card{border:1px solid #dfe3e6;border-radius:8px;padding:1rem;margin:1rem 0}
button{cursor:pointer}small{color:#5f6b72}</style></head><body>${inner}</body></html>`;
  }

  function loginPage(err) {
    return pageShell('Login', `<h1>Duplicate Merge Queue</h1>
${err ? `<p style="color:#b3261e">${esc(err)}</p>` : ''}
<form method="post" action="/login"><label>Operator password <input type="password" name="password" required></label>
<button type="submit">Log in</button></form>
<p><small><a href="/oauth/authorize">Connect a HubSpot portal</a></small></p>`);
  }

  function recordTable(rec, other, objectType) {
    const fields = objectType === 'companies'
      ? ['name', 'domain', 'phone', 'website', 'industry', 'city', 'country']
      : ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company', 'jobtitle', 'city', 'country'];
    const p = rec.properties || {};
    const q = (other && other.properties) || {};
    const rows = fields.map((f) => {
      const diff = String(p[f] ?? '') !== String(q[f] ?? '');
      return `<tr${diff ? ' class="diff"' : ''}><th>${esc(f)}</th><td>${esc(p[f] ?? '')}</td></tr>`;
    }).join('');
    return `<table><tr><th colspan="2">Record ${esc(rec.id)} <small>(updated ${esc(rec.updatedAt || '')})</small></th></tr>${rows}</table>`;
  }

  function queuePage(portal) {
    if (!portal) {
      return pageShell('Queue', `<h1>Duplicate Merge Queue</h1><p>No portal connected yet. <a href="/oauth/authorize">Connect HubSpot</a></p>`);
    }
    const pending = store.listProposals(portal.portalId, 'pending');
    const header = `<h1>Duplicate Merge Queue</h1>
<p>Portal <strong>${esc(portal.portalId)}</strong> · plan <strong>${esc(portal.plan)}</strong> · last scan ${esc(portal.lastScanAt || 'never')}
<form method="post" action="/scan/run" style="display:inline"><button type="submit">Run scan</button></form>
<form method="post" action="/logout" style="display:inline"><button type="submit">Log out</button></form></p>`;

    if (portal.plan !== 'paid') {
      return pageShell('Queue', `${header}
<div class="card"><h2>${pending.length} duplicate pair${pending.length === 1 ? '' : 's'} found</h2>
<p>The free tier shows the count. Upgrade to the portal plan ($29/mo) to review pairs side-by-side and approve merges.</p>
${stripe.configured
          ? '<form method="post" action="/billing/checkout"><button type="submit">Upgrade — $29/mo per portal</button></form>'
          : '<p><small>Billing is not configured on this deployment yet.</small></p>'}
</div>`);
    }

    const renderProposal = (p) => {
      const a = store.getRecord(portal.portalId, p.objectType, p.aId);
      const b = store.getRecord(portal.portalId, p.objectType, p.bId);
      const reasons = (p.reasons || []).map((r) => `<li>${esc(r.detail)} <small>(+${r.points})</small></li>`).join('');
      return `<div class="card">
<p><span class="score">Score ${p.score}</span>${p.caution ? ' <span class="caution">⚠ caution</span>' : ''} · ${esc(p.objectType)} · pair ${esc(p.aId)} / ${esc(p.bId)}</p>
<ul>${reasons}</ul>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">${a ? recordTable(a, b, p.objectType) : '<p>record A missing</p>'}${b ? recordTable(b, a, p.objectType) : '<p>record B missing</p>'}</div>
<form method="post" action="/proposals/${esc(p.id)}/approve">
<label>Surviving record <select name="survivorId"><option value="">Most complete / recent (default)</option>
<option value="${esc(p.aId)}">${esc(p.aId)}</option><option value="${esc(p.bId)}">${esc(p.bId)}</option></select></label>
<button type="submit">Approve merge</button></form>
<form method="post" action="/proposals/${esc(p.id)}/dismiss"><input name="reason" placeholder="Dismissal reason" required>
<button type="submit">Dismiss</button></form>
<form method="post" action="/proposals/${esc(p.id)}/snooze"><button type="submit">Snooze pair</button></form>
</div>`;
    };
    const strong = pending.filter((p) => !p.caution);
    const caution = pending.filter((p) => p.caution);
    return pageShell('Queue', `${header}
<h2>Proposed merges (${strong.length})</h2>${strong.map(renderProposal).join('') || '<p>None.</p>'}
<h2>Caution — review carefully (${caution.length})</h2>${caution.map(renderProposal).join('') || '<p>None.</p>'}`);
  }

  /* ---------- handlers ---------- */

  async function handleApprove(req, res, id) {
    const portal = currentPortal();
    if (!portal) return json(res, 400, { error: 'no portal connected' });
    if (portal.plan !== 'paid') return json(res, 403, { error: 'review queue requires the paid portal plan' });
    const proposal = store.getProposal(id);
    if (!proposal || proposal.portalId !== portal.portalId) return json(res, 404, { error: 'proposal not found' });
    if (proposal.status !== 'pending') return json(res, 409, { error: `proposal is ${proposal.status}` });
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    const recordA = store.getRecord(portal.portalId, proposal.objectType, proposal.aId);
    const recordB = store.getRecord(portal.portalId, proposal.objectType, proposal.bId);
    if (!recordA || !recordB) return json(res, 409, { error: 'records no longer in store; re-run a scan' });

    // 1) Plan + snapshot FIRST. The snapshot persists before any merge call.
    const plan = planMerge({
      portalId: portal.portalId, objectType: proposal.objectType,
      recordA, recordB, survivorId: form.get('survivorId') || undefined, takenBy: 'operator',
    });
    store.saveSnapshot(plan.snapshot);
    store.appendAudit({ portalId: portal.portalId, actor: 'operator', action: 'snapshot_saved', proposalId: id, detail: `snapshot ${plan.snapshot.id}: primary ${plan.survivorId}, secondary ${plan.mergedId}` });

    // 2) Execute the merge.
    try {
      const bundle = await freshTokens({ client: hubspot, vault, store, portal });
      const result = await hubspot.mergeObjects(bundle.accessToken, proposal.objectType, plan.survivorId, plan.mergedId);
      store.appendAudit({ portalId: portal.portalId, actor: 'operator', action: 'merge_executed', proposalId: id, detail: `merged ${plan.mergedId} into ${plan.survivorId}; result id ${result && result.id ? result.id : 'n/a'}` });
      store.updateProposal(id, { status: 'merged', snapshotId: plan.snapshot.id, survivorId: plan.survivorId, mergedId: plan.mergedId });
      return redirect(res, '/queue');
    } catch (err) {
      store.appendAudit({ portalId: portal.portalId, actor: 'operator', action: 'merge_failed', proposalId: id, detail: String(err.message || err) });
      store.updateProposal(id, { status: 'merge_failed', snapshotId: plan.snapshot.id });
      return json(res, 502, { error: 'merge failed; snapshot retained', detail: String(err.message || err) });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (p === '/health') {
        return json(res, 200, { ok: true, service: 'duplicate-merge-queue', billingConfigured: stripe.configured });
      }

      if (p === '/login' && req.method === 'GET') return send(res, 200, loginPage());
      if (p === '/login' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        if (!passwordHash || !verifyPassword(form.get('password') || '', passwordHash)) {
          return send(res, 401, loginPage('Wrong password.'));
        }
        return redirect(res, '/queue', { 'Set-Cookie': `dmq_session=${signSession(sessionSecret)}; HttpOnly; Path=/; SameSite=Lax` });
      }
      if (p === '/logout' && req.method === 'POST') {
        return redirect(res, '/login', { 'Set-Cookie': 'dmq_session=; HttpOnly; Path=/; Max-Age=0' });
      }

      if (p === '/oauth/authorize' && req.method === 'GET') {
        const state = createOAuthState(sessionSecret);
        return redirect(res, hubspot.authorizeUrl(state));
      }
      if (p === '/oauth/callback' && req.method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !verifyOAuthState(state, sessionSecret)) {
          return json(res, 400, { error: 'invalid OAuth callback (bad or expired state)' });
        }
        const tokens = await hubspot.exchangeCode(code);
        const info = await hubspot.getAccessTokenInfo(tokens.access_token);
        const portalId = String(info.hub_id || info.hubId || '');
        if (!portalId) return json(res, 502, { error: 'could not determine portal id from token info' });
        store.upsertPortal(portalId, {
          tokens: vault.seal({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: new Date(Date.now() + (tokens.expires_in || 1800) * 1000).toISOString(),
          }),
        });
        store.appendAudit({ portalId, actor: 'operator', action: 'portal_connected' });
        // Full scan on first connect (best effort; queue page works regardless).
        try { await scanPortal({ client: hubspot, vault, store, portalId, incremental: false }); } catch (err) {
          store.appendAudit({ portalId, actor: 'scanner', action: 'scan_failed', detail: String(err.message || err) });
        }
        return redirect(res, '/queue');
      }

      if (p === '/billing/webhook' && req.method === 'POST') {
        if (!stripe.configured && !stripe.webhookConfigured) return json(res, 503, { error: 'billing not configured' });
        const raw = (await readBody(req)).toString('utf8');
        let event;
        try {
          event = stripe.constructEvent(raw, req.headers['stripe-signature']);
        } catch (_) {
          return json(res, 400, { error: 'invalid signature' });
        }
        applyStripeEvent(store, event);
        return json(res, 200, { received: true });
      }

      // Everything below requires the operator session.
      if (!authed(req)) {
        if (p.startsWith('/api') || req.method === 'POST') return json(res, 401, { error: 'login required' });
        return redirect(res, '/login');
      }

      if (p === '/' || p === '/queue') return send(res, 200, queuePage(currentPortal()));

      if (p === '/api/status') {
        const portal = currentPortal();
        return json(res, 200, {
          portal: portal ? { portalId: portal.portalId, plan: portal.plan, lastScanAt: portal.lastScanAt || null } : null,
          pendingProposals: portal ? store.listProposals(portal.portalId, 'pending').length : 0,
          billingConfigured: stripe.configured,
        });
      }

      if (p === '/scan/run' && req.method === 'POST') {
        const portal = currentPortal();
        if (!portal) return json(res, 400, { error: 'no portal connected' });
        await readBody(req);
        const summary = await scanPortal({ client: hubspot, vault, store, portalId: portal.portalId, incremental: true });
        store.appendAudit({ portalId: portal.portalId, actor: 'operator', action: 'scan_manual', detail: JSON.stringify(summary) });
        return redirect(res, '/queue');
      }

      if (p === '/billing/checkout' && req.method === 'POST') {
        await readBody(req);
        const portal = currentPortal();
        if (!portal) return json(res, 400, { error: 'no portal connected' });
        if (!stripe.configured) return json(res, 503, { error: 'billing not configured' });
        const base = env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 8080}`;
        const session = await stripe.createCheckoutSession({
          portalId: portal.portalId,
          successUrl: `${base}/queue?upgraded=1`,
          cancelUrl: `${base}/queue`,
        });
        return redirect(res, session.url);
      }

      const m = p.match(/^\/proposals\/([^/]+)\/(approve|dismiss|snooze)$/);
      if (m && req.method === 'POST') {
        const [, id, action] = m;
        if (action === 'approve') return handleApprove(req, res, decodeURIComponent(id));
        const portal = currentPortal();
        const proposal = store.getProposal(decodeURIComponent(id));
        if (!portal || !proposal || proposal.portalId !== portal.portalId) return json(res, 404, { error: 'proposal not found' });
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        if (action === 'dismiss') {
          store.updateProposal(proposal.id, { status: 'dismissed', dismissReason: form.get('reason') || '' });
          store.appendAudit({ portalId: portal.portalId, actor: 'operator', action: 'proposal_dismissed', proposalId: proposal.id, detail: form.get('reason') || '' });
        } else {
          store.updateProposal(proposal.id, { status: 'snoozed' });
          store.appendAudit({ portalId: portal.portalId, actor: 'operator', action: 'proposal_snoozed', proposalId: proposal.id });
        }
        return redirect(res, '/queue');
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    }
  });

  return { server, store, vault, hubspot, stripe };
}

if (require.main === module) {
  loadDotEnv();
  const { server } = createApp(process.env);
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => console.log(`duplicate-merge-queue listening on :${port}`));
}

module.exports = { createApp };
