'use strict';
/* Shared fixture records + a scriptable fake transport for the API clients. */

const contact = (id, props, updatedAt = '2026-11-01T10:00:00Z') => ({
  id: String(id), createdAt: '2026-01-01T00:00:00Z', updatedAt, properties: props,
});
const company = (id, props, updatedAt = '2026-11-01T10:00:00Z') => ({
  id: String(id), createdAt: '2026-01-01T00:00:00Z', updatedAt, properties: props,
});

/** Transport recorder: handlers keyed by a predicate on {method, url}; records every call. */
function fixtureTransport(routes) {
  const calls = [];
  async function transport({ method, url, headers, body }) {
    calls.push({ method, url, headers, body });
    for (const [pred, handler] of routes) {
      if (pred({ method, url, body })) {
        const out = typeof handler === 'function' ? handler({ method, url, body }) : handler;
        return out.status !== undefined ? out : { status: 200, body: JSON.stringify(out) };
      }
    }
    throw new Error(`fixture transport: no route for ${method} ${url}`);
  }
  transport.calls = calls;
  return transport;
}

module.exports = { contact, company, fixtureTransport };
