'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HubSpotClient, createOAuthState, verifyOAuthState } = require('../src/hubspot');
const { fixtureTransport, contact } = require('./fixtures');

const client = (transport) => new HubSpotClient({
  clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost:8080/oauth/callback', transport,
});

test('authorizeUrl carries client, scopes, redirect and state', () => {
  const url = client(fixtureTransport([])).authorizeUrl('STATE123');
  assert.match(url, /^https:\/\/app\.hubspot\.com\/oauth\/authorize\?/);
  assert.ok(url.includes('client_id=cid'));
  assert.ok(url.includes('state=STATE123'));
  assert.ok(decodeURIComponent(url).includes('crm.objects.contacts.read'));
});

test('exchangeCode posts the authorization_code grant', async () => {
  const transport = fixtureTransport([
    [({ url }) => url.endsWith('/oauth/v1/token'), { access_token: 'AT', refresh_token: 'RT', expires_in: 1800 }],
  ]);
  const res = await client(transport).exchangeCode('CODE42');
  assert.equal(res.access_token, 'AT');
  const body = transport.calls[0].body;
  assert.ok(body.includes('grant_type=authorization_code'));
  assert.ok(body.includes('code=CODE42'));
  assert.equal(transport.calls[0].headers.Authorization, undefined, 'token endpoint is not bearer-authed');
});

test('refreshTokens posts the refresh_token grant', async () => {
  const transport = fixtureTransport([
    [({ url }) => url.endsWith('/oauth/v1/token'), { access_token: 'AT2', refresh_token: 'RT2', expires_in: 1800 }],
  ]);
  const res = await client(transport).refreshTokens('RT');
  assert.equal(res.access_token, 'AT2');
  assert.ok(transport.calls[0].body.includes('grant_type=refresh_token'));
});

test('listAllObjects follows pagination cursors to exhaustion', async () => {
  const transport = fixtureTransport([
    [({ url }) => url.includes('/crm/v3/objects/contacts') && !url.includes('after='), {
      results: [contact(1, {}), contact(2, {})], paging: { next: { after: 'CURSOR1' } },
    }],
    [({ url }) => url.includes('after=CURSOR1'), { results: [contact(3, {})] }],
  ]);
  const all = await client(transport).listAllObjects('AT', 'contacts', { properties: ['email'] });
  assert.deepEqual(all.map((r) => r.id), ['1', '2', '3']);
  assert.equal(transport.calls.length, 2);
  assert.ok(transport.calls.every((c) => c.headers.Authorization === 'Bearer AT'));
});

test('batchRead posts inputs; getAccessTokenInfo reads hub id', async () => {
  const transport = fixtureTransport([
    [({ url }) => url.includes('/batch/read'), { results: [contact(9, {})] }],
    [({ url }) => url.includes('/oauth/v1/access-tokens/'), { hub_id: 12345, user: 'op@example.com' }],
  ]);
  const c = client(transport);
  const res = await c.batchRead('AT', 'contacts', [9, 10], { properties: ['email'] });
  assert.equal(res.results.length, 1);
  const sent = JSON.parse(transport.calls[0].body);
  assert.deepEqual(sent.inputs, [{ id: '9' }, { id: '10' }]);
  const info = await c.getAccessTokenInfo('AT');
  assert.equal(info.hub_id, 12345);
});

test('mergeObjects posts primaryObjectId/objectIdToMerge to the merge endpoint', async () => {
  const transport = fixtureTransport([
    [({ url }) => url.endsWith('/crm/v3/objects/contacts/merge'), { id: '1', properties: {} }],
  ]);
  const res = await client(transport).mergeObjects('AT', 'contacts', '1', '2');
  assert.equal(res.id, '1');
  assert.equal(transport.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(transport.calls[0].body), { primaryObjectId: '1', objectIdToMerge: '2' });
});

test('API errors surface status and body', async () => {
  const transport = fixtureTransport([
    [() => true, { status: 429, body: JSON.stringify({ message: 'rate limited' }) }],
  ]);
  await assert.rejects(() => client(transport).listObjects('AT', 'contacts'), /429/);
});

test('OAuth state: valid passes; tampered, expired, wrong-secret and garbage fail', () => {
  const secret = 'session-secret';
  const state = createOAuthState(secret);
  assert.equal(verifyOAuthState(state, secret), true);
  assert.equal(verifyOAuthState(state, 'other-secret'), false);
  const [body, sig] = state.split('.');
  assert.equal(verifyOAuthState(`${body}.${sig.slice(0, -2)}xx`, secret), false);
  assert.equal(verifyOAuthState('garbage', secret), false);
  assert.equal(verifyOAuthState('', secret), false);
  assert.equal(verifyOAuthState(state, secret, Date.now() + 11 * 60 * 1000), false, 'expired after ttl');
});
