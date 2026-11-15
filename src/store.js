'use strict';
/*
 * Tiny JSON-file store, following the SameTree discipline: two processes
 * share the file (web server + sweep cron), so every mutation runs inside
 * a lockfile-held transaction that RELOADS from disk first, applies the
 * change, then writes back atomically (tmp + rename). Reads reload first;
 * the atomic rename means a reader never sees a partial file.
 */
const fs = require('fs');
const path = require('path');

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.lockPath = filePath + '.lock';
    this.data = Store.emptyData();
    this.load();
  }

  static emptyData() {
    return {
      portals: {},    // portalId -> { portalId, plan, connectedAt, tokens, lastScanAt, lastFullScanAt }
      records: {},    // `${portalId}:${objectType}:${id}` -> HubSpot record as last seen
      proposals: {},  // id -> proposal (see upsertProposal)
      snapshots: {},  // id -> pre-merge snapshot (see merge.js buildSnapshot)
      auditLog: [],   // { at, portalId, actor, action, proposalId, detail }
    };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...Store.emptyData(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = Store.emptyData();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.filePath);
  }

  acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        return fs.openSync(this.lockPath, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const st = fs.statSync(this.lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(this.lockPath); continue; }
        } catch (_) { continue; }
        if (Date.now() > deadline) throw new Error(`store lock timeout: ${this.lockPath}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  }

  transact(mutate) {
    const fd = this.acquireLock();
    try {
      this.load();
      const result = mutate(this.data);
      this.save();
      return result;
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(this.lockPath); } catch (_) {}
    }
  }

  /* -------- portals -------- */

  upsertPortal(portalId, patch) {
    return this.transact((data) => {
      const cur = data.portals[portalId] || { portalId, plan: 'free', connectedAt: new Date().toISOString() };
      data.portals[portalId] = { ...cur, ...patch, portalId };
      return data.portals[portalId];
    });
  }

  getPortal(portalId) {
    this.load();
    return this.data.portals[portalId] || null;
  }

  listPortals() {
    this.load();
    return Object.values(this.data.portals);
  }

  setPlan(portalId, plan) {
    return this.upsertPortal(portalId, { plan });
  }

  /* -------- records -------- */

  recordKey(portalId, objectType, id) { return `${portalId}:${objectType}:${id}`; }

  upsertRecord(portalId, objectType, record) {
    this.transact((data) => {
      data.records[this.recordKey(portalId, objectType, record.id)] = record;
    });
  }

  getRecord(portalId, objectType, id) {
    this.load();
    return this.data.records[this.recordKey(portalId, objectType, id)] || null;
  }

  listRecords(portalId, objectType) {
    this.load();
    const prefix = `${portalId}:${objectType}:`;
    return Object.entries(this.data.records)
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
  }

  /* -------- proposals -------- */

  pairKey(portalId, objectType, aId, bId) {
    const [x, y] = String(aId) < String(bId) ? [aId, bId] : [bId, aId];
    return `${portalId}:${objectType}:${x}:${y}`;
  }

  /** Insert a proposal if none exists for the pair; returns {proposal, created}. */
  upsertProposal(p) {
    return this.transact((data) => {
      const key = this.pairKey(p.portalId, p.objectType, p.aId, p.bId);
      const existing = Object.values(data.proposals).find((q) => q.pairKey === key);
      if (existing) {
        // Refresh score/reasons only while still pending.
        if (existing.status === 'pending') {
          existing.score = p.score; existing.caution = p.caution; existing.reasons = p.reasons;
          existing.updatedAt = new Date().toISOString();
        }
        return { proposal: existing, created: false };
      }
      const proposal = {
        id: `prop_${key.replace(/[^a-zA-Z0-9]+/g, '_')}`,
        pairKey: key,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...p,
      };
      data.proposals[proposal.id] = proposal;
      return { proposal, created: true };
    });
  }

  getProposal(id) {
    this.load();
    return this.data.proposals[id] || null;
  }

  listProposals(portalId, status) {
    this.load();
    return Object.values(this.data.proposals)
      .filter((p) => p.portalId === portalId && (!status || p.status === status))
      .sort((a, b) => b.score - a.score);
  }

  updateProposal(id, patch) {
    return this.transact((data) => {
      if (!data.proposals[id]) return null;
      data.proposals[id] = { ...data.proposals[id], ...patch, updatedAt: new Date().toISOString() };
      return data.proposals[id];
    });
  }

  /* -------- snapshots + audit -------- */

  saveSnapshot(snapshot) {
    this.transact((data) => { data.snapshots[snapshot.id] = snapshot; });
  }

  getSnapshot(id) {
    this.load();
    return this.data.snapshots[id] || null;
  }

  appendAudit(entry) {
    this.transact((data) => {
      data.auditLog.push({ at: new Date().toISOString(), ...entry });
    });
  }

  listAudit(portalId) {
    this.load();
    return this.data.auditLog.filter((e) => !portalId || e.portalId === portalId);
  }
}

module.exports = { Store };
