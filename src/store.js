'use strict';
// Store: documents + inverted index + named recalls + append-only audit chain.
//
// epoch increments on every state-changing op (load/delete/recall). Revoking a
// recall restores the epoch to that recall's pre-epoch, but the audit chain is
// append-only: history is never rewritten.

import { createHash } from 'node:crypto';
import { InvertedIndex } from './index.js';
import { normalizeQuery, canonical } from './text.js';

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ZERO_HASH = '0'.repeat(64);

export class Store {
  constructor() {
    this.epoch = 0;       // global op counter (load/delete/recall bump it)
    this.indexEpoch = 0;  // epoch at last index mutation; recall idempotency key
    this.index = new InvertedIndex();
    this.docList = [];            // raw docs in insertion order (for rebuild)
    this.recalls = new Map();     // id -> recall record
    this.byQuery = new Map();     // `${queryHash}@${epoch}` -> recallId
    this.recallSeq = 0;
    this.audit = [];              // append-only hash-chained entries
  }

  _head() {
    return this.audit.length ? this.audit[this.audit.length - 1].hash : ZERO_HASH;
  }

  _append(type, payload) {
    const seq = this.audit.length;
    const prevHash = this._head();
    const entry = { seq, epoch: this.epoch, type, payload, prevHash };
    entry.hash = sha256(canonical({ seq, epoch: entry.epoch, type, payload, prevHash }));
    this.audit.push(entry);
    return entry;
  }

  loadBatch(batch) {
    if (!batch || typeof batch.batchId !== 'string' || !Array.isArray(batch.docs)) {
      throw new StoreError('E_LOAD', 'batch must be {batchId, docs:[...]}');
    }
    const batchId = batch.batchId;
    if (this.index.batches.has(batchId)) {
      throw new StoreError('E_DUP', 'batch already loaded: ' + batchId);
    }
    const ids = [];
    for (const d of batch.docs) {
      if (this.index.docs.has(String(d.id))) {
        throw new StoreError('E_DUP', 'duplicate doc id: ' + d.id);
      }
      ids.push(String(d.id));
    }
    for (const d of batch.docs) {
      const rec = this.index.addDocument({ ...d, batchId });
      this.docList.push({ id: rec.id, batchId, description: rec.description, defectCode: d.defectCode, batchCode: d.batchCode });
    }
    this.epoch++;
    this.indexEpoch = this.epoch;
    this._append('LOAD', { batchId, docIds: ids.slice().sort(), epoch: this.epoch });
    return { batchId, docCount: ids.length, epoch: this.epoch };
  }

  deleteBatch(batchId) {
    const removed = this.index.removeBatch(batchId);
    if (!removed) {
      throw new StoreError('E_EPOCH', 'unknown batch: ' + batchId);
    }
    this.docList = this.docList.filter((d) => d.batchId !== batchId);
    this.epoch++;
    this.indexEpoch = this.epoch;
    this._append('DELETE', { batchId, docIds: removed, epoch: this.epoch });
    return { batchId, removed, epoch: this.epoch };
  }

  recall(query, name) {
    const nq = normalizeQuery(query);
    if (!nq.phraseTokens.length && !nq.defectCode && !nq.batchCode) {
      throw new StoreError('E_LOAD', 'recall needs at least one condition');
    }
    const queryHash = sha256(canonical(nq.public));
    const key = queryHash + '@' + this.indexEpoch;
    if (name && this.recalls.has(name)) {
      const existing = this.recalls.get(name);
      if (existing.queryHash === queryHash && existing.indexEpoch === this.indexEpoch && !existing.revoked) {
        return { rec: existing, created: false };
      }
      throw new StoreError('E_DUP', 'recall name already used with different query/epoch: ' + name);
    }
    const knownId = this.byQuery.get(key);
    if (knownId) {
      const known = this.recalls.get(knownId);
      if (known && !known.revoked) return { rec: known, created: false };
    }
    const bitmap = this.index.search(nq);
    const hits = bitmap.toArray().map((no) => this.index.byNo[no].id).sort();
    const hitsHash = sha256(canonical(hits));
    const preEpoch = this.epoch;
    this.epoch++;
    let id = name;
    if (!id) {
      do {
        id = 'R' + ++this.recallSeq;
      } while (this.recalls.has(id));
    }
    const entry = this._append('RECALL', {
      recallId: id, queryHash, hitsHash, epoch: this.epoch, preEpoch,
    });
    const rec = {
      id, query: nq.public, queryHash, hits, hitsHash,
      epoch: this.epoch, preEpoch, indexEpoch: this.indexEpoch,
      revoked: false, recallHash: entry.hash,
    };
    this.recalls.set(id, rec);
    this.byQuery.set(key, id);
    return { rec, created: true };
  }

  revoke(recallId) {
    const rec = this.recalls.get(recallId);
    if (!rec) throw new StoreError('E_EPOCH', 'unknown recall: ' + recallId);
    if (rec.revoked) throw new StoreError('E_DUP', 'recall already revoked: ' + recallId);
    if (this.epoch !== rec.epoch) {
      throw new StoreError('E_EPOCH',
        `cannot revoke ${recallId}: epoch moved on (current ${this.epoch}, recall at ${rec.epoch})`);
    }
    rec.revoked = true;
    this.epoch = rec.preEpoch;
    const entry = this._append('REVOKE', {
      recallId, recallHash: rec.recallHash, restoredEpoch: this.epoch,
    });
    rec.revokeHash = entry.hash;
    return { recallId, restoredEpoch: this.epoch, revokeHash: entry.hash };
  }

  verifyAudit() {
    let prev = ZERO_HASH;
    for (let i = 0; i < this.audit.length; i++) {
      const e = this.audit[i];
      if (e.seq !== i || e.prevHash !== prev) return { ok: false, at: i };
      const expect = sha256(canonical({ seq: e.seq, epoch: e.epoch, type: e.type, payload: e.payload, prevHash: e.prevHash }));
      if (expect !== e.hash) return { ok: false, at: i };
      prev = e.hash;
    }
    // Referential integrity: the chain must account for the live state, so
    // truncating/rewriting tail entries (e.g. erasing a REVOKE) is detected.
    if (this.audit.length && this.audit[this.audit.length - 1].epoch !== this.epoch) {
      return { ok: false, at: 'epoch' };
    }
    const hashes = new Set(this.audit.map((e) => e.hash));
    for (const rec of this.recalls.values()) {
      if (!hashes.has(rec.recallHash)) return { ok: false, at: 'recall:' + rec.id };
      if (rec.revoked && !hashes.has(rec.revokeHash)) return { ok: false, at: 'revoke:' + rec.id };
      if (!rec.revoked && rec.revokeHash) return { ok: false, at: 'revoke:' + rec.id };
    }
    return { ok: true, length: this.audit.length, head: prev };
  }

  prove(recallId) {
    const rec = this.recalls.get(recallId);
    if (!rec) throw new StoreError('E_PROOF', 'unknown recall: ' + recallId);
    if (sha256(canonical(rec.query)) !== rec.queryHash) {
      throw new StoreError('E_PROOF', 'query hash mismatch (tampered store)');
    }
    if (sha256(canonical(rec.hits)) !== rec.hitsHash) {
      throw new StoreError('E_PROOF', 'hits hash mismatch (tampered store)');
    }
    const chain = this.verifyAudit();
    if (!chain.ok) throw new StoreError('E_PROOF', 'audit chain broken at entry ' + chain.at);
    const recallEntry = this.audit.find(
      (e) => e.type === 'RECALL' && e.payload.recallId === recallId && e.hash === rec.recallHash);
    if (!recallEntry) throw new StoreError('E_PROOF', 'recall event missing from audit chain');
    const p = recallEntry.payload;
    if (p.queryHash !== rec.queryHash || p.hitsHash !== rec.hitsHash || p.epoch !== rec.epoch) {
      throw new StoreError('E_PROOF', 'recall record does not match audit event');
    }
    if (rec.revoked) {
      const revokeEntry = this.audit.find(
        (e) => e.type === 'REVOKE' && e.payload.recallId === recallId && e.hash === rec.revokeHash);
      if (!revokeEntry) throw new StoreError('E_PROOF', 'revoke event missing from audit chain');
    }
    return {
      recallId,
      epoch: rec.epoch,
      query: rec.query,
      queryHash: rec.queryHash,
      hits: rec.hits,
      hitsHash: rec.hitsHash,
      recallHash: rec.recallHash,
      revoked: rec.revoked,
      revokeHash: rec.revokeHash ?? null,
      auditHead: chain.head,
      auditLength: chain.length,
    };
  }

  auditReport() {
    const chain = this.verifyAudit();
    return {
      ok: chain.ok,
      head: chain.head ?? null,
      length: this.audit.length,
      epoch: this.epoch,
      entries: this.audit.map((e) => ({
        seq: e.seq, epoch: e.epoch, type: e.type, payload: e.payload,
        prevHash: e.prevHash, hash: e.hash,
      })),
    };
  }

  toJSON() {
    return {
      version: 1,
      epoch: this.epoch,
      indexEpoch: this.indexEpoch,
      recallSeq: this.recallSeq,
      docList: this.docList,
      recalls: [...this.recalls.values()],
      byQuery: [...this.byQuery],
      audit: this.audit,
    };
  }

  static fromJSON(obj) {
    const s = new Store();
    s.epoch = obj.epoch;
    s.indexEpoch = obj.indexEpoch ?? 0;
    s.recallSeq = obj.recallSeq;
    s.docList = obj.docList;
    for (const d of obj.docList) s.index.addDocument(d);
    s.recalls = new Map(obj.recalls.map((r) => [r.id, r]));
    s.byQuery = new Map(obj.byQuery);
    s.audit = obj.audit;
    return s;
  }
}
