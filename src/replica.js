import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonical } from './canonical.js';
import { leafHash, merkleRoot } from './merkle.js';
import * as vv from './vv.js';
import { ApiError } from './errors.js';

export const ALGORITHM = 'sha256-merkle-v1';
export const CONFLICT_RESOLVE_DELETE = 'concurrent-resolve-delete';

function emptyState(replica) {
  return { replica, vv: {}, records: {}, tombstones: {}, conflicts: {} };
}

function byId(x, y) {
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

function recordRank(r) {
  return [r.status === 'resolved' ? 1 : 0, r.amountA, r.amountB];
}

function compareRank(x, y) {
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return 0;
}

export class Replica {
  constructor(id, state) {
    this.id = id;
    this.state = state || emptyState(id);
  }

  static load(file) {
    const id = path.basename(file).replace(/\.[^.]*$/, '') || 'replica';
    if (!existsSync(file)) return new Replica(id);
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return new Replica(state.replica || id, state);
  }

  save(file) {
    writeFileSync(file, JSON.stringify(this.state, null, 2) + '\n');
  }

  tick() {
    this.state.vv[this.id] = (this.state.vv[this.id] || 0) + 1;
    return { ...this.state.vv };
  }

  upsert(id, amountA, amountB) {
    const version = this.tick();
    const existing = this.state.records[id];
    // A local upsert always observes any local tombstone, so a re-create is
    // legitimate and supersedes the delete.
    this.state.records[id] = {
      id,
      amountA,
      amountB,
      status: existing ? existing.status : 'open',
      vv: version,
    };
    delete this.state.tombstones[id];
    delete this.state.conflicts[id];
    return this.state.records[id];
  }

  resolve(id) {
    const rec = this.state.records[id];
    if (!rec) throw new ApiError('not-found', { id });
    const version = this.tick();
    rec.status = 'resolved';
    rec.vv = version;
    delete this.state.conflicts[id];
    return rec;
  }

  delete(id) {
    if (this.state.tombstones[id]) return this.state.tombstones[id];
    if (!this.state.records[id]) throw new ApiError('not-found', { id });
    const version = this.tick();
    delete this.state.records[id];
    this.state.tombstones[id] = { id, vv: version };
    delete this.state.conflicts[id];
    return this.state.tombstones[id];
  }

  // Merge a remote replica state (or an equivalent structure). Stale re-adds
  // of locally deleted ids are rejected individually (never resurrected) and
  // reported in the returned `stale` list; everything else is applied so
  // anti-entropy still converges.
  merge(remoteState) {
    const remote = structuredClone(remoteState);
    const remoteRecords = remote.records || {};
    const remoteTombstones = remote.tombstones || {};

    const applied = { records: [], tombstones: [], stale: [] };
    const stale = new Set();
    for (const id of Object.keys(remoteRecords)) {
      const tomb = this.state.tombstones[id];
      if (!tomb) continue;
      const rec = remoteRecords[id];
      const rel = vv.compare(rec.vv, tomb.vv);
      if (rel === 2 && rec.status !== 'resolved') {
        // Re-add that never observed the tombstone: rejected, no resurrection.
        stale.add(id);
        applied.stale.push(id);
      }
    }

    for (const id of Object.keys(remoteRecords).sort()) {
      if (stale.has(id)) continue;
      this.applyRecord(remoteRecords[id], applied);
    }
    for (const id of Object.keys(remoteTombstones).sort()) {
      this.applyTombstone(remoteTombstones[id], applied);
    }
    this.state.vv = vv.merge(this.state.vv, remote.vv || {});
    for (const cid of Object.keys(remote.conflicts || {})) {
      if (!this.state.conflicts[cid]) this.state.conflicts[cid] = remote.conflicts[cid];
    }
    return applied;
  }

  applyRecord(rec, applied) {
    const id = rec.id;
    const tomb = this.state.tombstones[id];
    if (tomb) {
      const rel = vv.compare(rec.vv, tomb.vv);
      if (rel === 1 || rel === 0) {
        // Record observed the delete: legitimate re-create wins.
        delete this.state.tombstones[id];
        this.state.records[id] = rec;
        applied.records.push(id);
      } else if (rel === 2 && rec.status === 'resolved') {
        // Concurrent resolve vs delete: tombstone wins, conflict recorded.
        this.state.conflicts[id] = { id, reason: CONFLICT_RESOLVE_DELETE };
      }
      // rel === -1: tombstone dominates, stale record ignored.
      // rel === 2 && open: rejected earlier as stale-resurrect.
      return;
    }
    const local = this.state.records[id];
    if (!local) {
      this.state.records[id] = rec;
      applied.records.push(id);
      return;
    }
    const rel = vv.compare(rec.vv, local.vv);
    if (rel === 1) {
      this.state.records[id] = rec;
      applied.records.push(id);
      return;
    }
    if (rel === -1 || rel === 0) return;
    // Concurrent writes to the same id: deterministic resolution so every
    // replica converges to the same value regardless of merge order.
    const cmp = compareRank(recordRank(rec), recordRank(local));
    if (cmp === 0) {
      local.vv = vv.merge(local.vv, rec.vv);
    } else if (cmp > 0) {
      this.state.records[id] = rec;
      applied.records.push(id);
    }
  }

  applyTombstone(tomb, applied) {
    const id = tomb.id;
    const localTomb = this.state.tombstones[id];
    if (localTomb) {
      localTomb.vv = vv.merge(localTomb.vv, tomb.vv);
      return;
    }
    const rec = this.state.records[id];
    if (!rec) {
      this.state.tombstones[id] = tomb;
      applied.tombstones.push(id);
      return;
    }
    const rel = vv.compare(tomb.vv, rec.vv);
    if (rel === -1) return; // Record observed the delete and wins.
    delete this.state.records[id];
    this.state.tombstones[id] = tomb;
    applied.tombstones.push(id);
    if (rel === 2 && rec.status === 'resolved') {
      // Concurrent resolve vs delete: delete wins, conflict recorded.
      this.state.conflicts[id] = { id, reason: CONFLICT_RESOLVE_DELETE };
    }
  }

  entries() {
    const list = [];
    for (const id of Object.keys(this.state.records)) {
      const r = this.state.records[id];
      const data = { amountA: r.amountA, amountB: r.amountB, status: r.status, vv: r.vv };
      list.push({ id, type: 'record', data, hash: leafHash({ type: 'record', id, ...data }) });
    }
    for (const id of Object.keys(this.state.tombstones)) {
      const t = this.state.tombstones[id];
      const data = { vv: t.vv };
      list.push({ id, type: 'tombstone', data, hash: leafHash({ type: 'tombstone', id, ...data }) });
    }
    list.sort(byId);
    return list;
  }

  epoch() {
    return Object.values(this.state.vv).reduce((acc, n) => acc + n, 0);
  }

  digest() {
    return merkleRoot(this.entries().map((e) => e.hash));
  }

  conflictList() {
    return Object.values(this.state.conflicts).sort(byId);
  }

  snapshot() {
    const entries = this.entries();
    const digest = merkleRoot(entries.map((e) => e.hash));
    const epoch = this.epoch();
    const conflicts = this.conflictList();
    const certificate = {
      algorithm: ALGORITHM,
      epoch,
      digest,
      valid: conflicts.length === 0,
      conflicts,
      leaves: entries,
    };
    return { replica: this.id, epoch, digest, entries, certificate };
  }
}

// Recompute a certificate from its leaves: leaf hashes, Merkle root, sort
// order and the valid flag must all be self-consistent.
export function verifyCertificate(cert) {
  if (!cert || cert.algorithm !== ALGORITHM || !Array.isArray(cert.leaves)) return false;
  const ids = cert.leaves.map((l) => l.id);
  if (canonical(ids) !== canonical([...ids].sort())) return false;
  for (const leaf of cert.leaves) {
    if (leaf.hash !== leafHash({ type: leaf.type, id: leaf.id, ...leaf.data })) return false;
  }
  if (merkleRoot(cert.leaves.map((l) => l.hash)) !== cert.digest) return false;
  if (typeof cert.epoch !== 'number' || cert.epoch < 0) return false;
  return cert.valid === ((cert.conflicts || []).length === 0);
}

// Anti-entropy diff: entries present (or different) in the remote snapshot
// but missing/stale locally, split by kind.
export function diffSnapshots(localSnap, remoteSnap) {
  const localById = new Map(localSnap.entries.map((e) => [e.id, e]));
  const missingRecords = [];
  const missingTombstones = [];
  for (const e of remoteSnap.entries || []) {
    const local = localById.get(e.id);
    if (!local || local.hash !== e.hash) {
      (e.type === 'tombstone' ? missingTombstones : missingRecords).push(e.id);
    }
  }
  return {
    equal: localSnap.digest === remoteSnap.digest,
    missingRecords,
    missingTombstones,
    local: { epoch: localSnap.epoch, digest: localSnap.digest },
    remote: { epoch: remoteSnap.epoch, digest: remoteSnap.digest },
  };
}

// Accepts either a full replica state file or a snapshot file and returns a
// state-shaped object suitable for Replica#merge.
export function normalizeRemoteState(json) {
  if (json && json.records && json.tombstones) return json;
  if (json && Array.isArray(json.entries)) {
    const state = emptyState(json.replica || 'remote');
    for (const e of json.entries) {
      if (e.type === 'record') state.records[e.id] = { id: e.id, ...e.data };
      else state.tombstones[e.id] = { id: e.id, ...e.data };
      state.vv = vv.merge(state.vv, (e.data && e.data.vv) || {});
    }
    for (const c of (json.certificate && json.certificate.conflicts) || []) {
      state.conflicts[c.id] = c;
    }
    return state;
  }
  throw new ApiError('usage');
}
