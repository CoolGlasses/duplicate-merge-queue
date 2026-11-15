'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { completeness, chooseSurvivor, buildSnapshot, buildMergePayload, planMerge } = require('../src/merge');
const { contact } = require('./fixtures');

const sparse = () => contact(1, { firstname: 'Jon', lastname: 'Smith' }, '2026-10-01T00:00:00Z');
const rich = () => contact(2, {
  firstname: 'John', lastname: 'Smith', email: 'john@acme.com', phone: '5550102233',
  company: 'Acme', jobtitle: 'CTO', city: 'Boston',
}, '2026-09-01T00:00:00Z');

test('completeness counts non-empty known fields', () => {
  assert.ok(completeness(rich(), 'contacts') > completeness(sparse(), 'contacts'));
});

test('chooseSurvivor: most complete wins even when older', () => {
  const { survivor, merged } = chooseSurvivor(sparse(), rich(), 'contacts');
  assert.equal(survivor.id, '2');
  assert.equal(merged.id, '1');
});

test('chooseSurvivor: tie on completeness -> most recently updated wins', () => {
  const a = contact(1, { firstname: 'A', email: 'a@x.com' }, '2026-10-05T00:00:00Z');
  const b = contact(2, { firstname: 'B', email: 'b@x.com' }, '2026-11-05T00:00:00Z');
  assert.equal(chooseSurvivor(a, b, 'contacts').survivor.id, '2');
});

test('buildSnapshot: shape + deep copy isolation', () => {
  const a = rich();
  const snap = buildSnapshot({ portalId: 'P1', objectType: 'contacts', primary: a, secondary: sparse(), takenBy: 'op' });
  assert.equal(snap.portalId, 'P1');
  assert.equal(snap.primaryId, '2');
  assert.equal(snap.secondaryId, '1');
  assert.ok(snap.id.startsWith('snap_'));
  assert.equal(snap.takenBy, 'op');
  a.properties.email = 'mutated@example.com';
  assert.equal(snap.primary.properties.email, 'john@acme.com', 'snapshot must be a deep copy');
});

test('buildMergePayload matches the HubSpot merge API shape', () => {
  assert.deepEqual(buildMergePayload(123, '456'), { primaryObjectId: '123', objectIdToMerge: '456' });
});

test('planMerge: default survivor + explicit override', () => {
  const plan = planMerge({ portalId: 'P1', objectType: 'contacts', recordA: sparse(), recordB: rich(), takenBy: 'op' });
  assert.equal(plan.survivorId, '2');
  assert.equal(plan.mergedId, '1');
  assert.deepEqual(plan.payload, { primaryObjectId: '2', objectIdToMerge: '1' });
  assert.equal(plan.snapshot.primaryId, '2');

  const override = planMerge({ portalId: 'P1', objectType: 'contacts', recordA: sparse(), recordB: rich(), survivorId: '1', takenBy: 'op' });
  assert.equal(override.survivorId, '1');
  assert.deepEqual(override.payload, { primaryObjectId: '1', objectIdToMerge: '2' });
});
