'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmq-store-'));
  return new Store(path.join(dir, 'store.json'));
}

test('store: two instances interleaving transactions lose nothing (race regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmq-race-'));
  const file = path.join(dir, 'store.json');
  const serverSide = new Store(file);
  const sweepSide = new Store(file);
  // Simulate the lost-update interleaving: both hold state, both write.
  for (let i = 0; i < 25; i++) {
    serverSide.appendAudit({ portalId: 'P', actor: 'server', action: `evt_server_${i}` });
    sweepSide.appendAudit({ portalId: 'P', actor: 'sweep', action: `evt_sweep_${i}` });
  }
  const check = new Store(file);
  const log = check.listAudit('P');
  assert.equal(log.length, 50);
  assert.equal(log.filter((e) => e.actor === 'server').length, 25);
  assert.equal(log.filter((e) => e.actor === 'sweep').length, 25);
});

test('store: proposal upsert dedupes by pair and refreshes only while pending', () => {
  const s = tmpStore();
  const p = { portalId: 'P', objectType: 'contacts', aId: '2', bId: '1', score: 70, caution: true, reasons: [] };
  const first = s.upsertProposal(p);
  assert.equal(first.created, true);
  const second = s.upsertProposal({ ...p, score: 90, caution: false });
  assert.equal(second.created, false);
  assert.equal(second.proposal.id, first.proposal.id);
  assert.equal(second.proposal.score, 90);
  s.updateProposal(first.proposal.id, { status: 'dismissed' });
  const third = s.upsertProposal({ ...p, score: 55 });
  assert.equal(third.proposal.score, 90, 'dismissed proposals are not refreshed');
  assert.equal(s.listProposals('P').length, 1);
});

test('store: portals, records, snapshots, plan', () => {
  const s = tmpStore();
  s.upsertPortal('P9', { tokens: 'sealed' });
  assert.equal(s.getPortal('P9').plan, 'free');
  s.setPlan('P9', 'paid');
  assert.equal(s.getPortal('P9').plan, 'paid');
  s.upsertRecord('P9', 'contacts', { id: '7', properties: { email: 'a@b.c' } });
  assert.equal(s.getRecord('P9', 'contacts', '7').properties.email, 'a@b.c');
  assert.equal(s.listRecords('P9', 'contacts').length, 1);
  assert.equal(s.listRecords('P9', 'companies').length, 0);
  s.saveSnapshot({ id: 'snap_x', primaryId: '1' });
  assert.equal(s.getSnapshot('snap_x').primaryId, '1');
});
