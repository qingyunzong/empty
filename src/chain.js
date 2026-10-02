import { randomInt } from 'node:crypto';
import { ChainError, CODES } from './errors.js';
import { GENESIS, hashEvent, leafHash } from './hash.js';
import { merkleRoot, merkleProof, verifyProof } from './merkle.js';
import { Store } from './store.js';

export const EVENT_TYPES = Object.freeze(['receive', 'transfer', 'analyze', 'destroy', 'revoke']);

// Recomputes the full hash chain; throws BROKEN_CHAIN at the first
// inconsistency, identifying the event sequence number.
export function validateChain(events) {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i) {
      throw new ChainError(CODES.BROKEN_CHAIN, `seq gap: expected ${i}, got ${e.seq}`, { seq: i });
    }
    if (e.prevHash !== prev) {
      throw new ChainError(CODES.BROKEN_CHAIN, `prevHash mismatch at seq ${i}`, { seq: i });
    }
    if (hashEvent(e) !== e.hash) {
      throw new ChainError(CODES.BROKEN_CHAIN, `event hash mismatch at seq ${i}`, { seq: i });
    }
    prev = e.hash;
  }
  return prev;
}

export class CustodyChain {
  constructor(store) {
    this.store = store;
    this.events = [];
    this.revokedConsents = new Set();
    this.head = GENESIS;
    this.manifest = null;
  }

  static open(dir) {
    const store = new Store(dir);
    store.ensure();
    store.cleanupTmp(); // crash recovery: discard in-flight snapshot temp
    const chain = new CustodyChain(store);
    chain.loadEvents(store.readEvents());
    const manifest = store.readManifest();
    if (manifest) chain.checkManifest(manifest);
    chain.manifest = manifest;
    return chain;
  }

  loadEvents(events) {
    validateChain(events);
    for (const e of events) {
      if (e.type === 'revoke') this.revokedConsents.add(e.consentId);
    }
    this.events = events;
    this.head = events.length ? events[events.length - 1].hash : GENESIS;
  }

  // Manifest must be consistent with the log prefix it claims to cover.
  checkManifest(manifest) {
    const { seq, leafCount, headHash, merkleRoot: root } = manifest;
    if (!Number.isInteger(seq) || seq < 0 || leafCount !== seq + 1) {
      throw new ChainError(CODES.BROKEN_CHAIN, 'manifest seq/leafCount inconsistent', { manifest });
    }
    if (leafCount > this.events.length) {
      throw new ChainError(CODES.BROKEN_CHAIN, 'manifest ahead of event log', {
        manifestSeq: seq, logLength: this.events.length,
      });
    }
    if (this.events[seq].hash !== headHash) {
      throw new ChainError(CODES.BROKEN_CHAIN, 'manifest headHash does not match log', { seq });
    }
    const leaves = this.events.slice(0, leafCount).map((e) => leafHash(e.hash));
    if (merkleRoot(leaves) !== root) {
      throw new ChainError(CODES.BROKEN_CHAIN, 'manifest merkleRoot does not match log', { seq });
    }
  }

  appendEvent({ type, actor, sampleId = null, consentId = null, reason = null, payload = null, ts = null }) {
    if (!EVENT_TYPES.includes(type)) {
      throw new ChainError(CODES.INVALID_EVENT, `unknown event type: ${type}`, { type });
    }
    if (!consentId) {
      throw new ChainError(CODES.INVALID_EVENT, 'consentId is required', { type });
    }
    if (type === 'revoke') {
      if (!reason) throw new ChainError(CODES.INVALID_EVENT, 'revoke requires a reason', { consentId });
    } else if (this.revokedConsents.has(consentId)) {
      // Tombstone: consent revoked -> no new event may depend on it.
      throw new ChainError(CODES.REVOKED_CONSENT, `consent ${consentId} has been revoked`, { consentId, type });
    }
    const rec = {
      seq: this.events.length,
      type,
      ts: ts ?? new Date().toISOString(),
      actor: actor ?? 'unknown',
      sampleId,
      consentId,
      reason,
      payload,
      prevHash: this.head,
    };
    rec.hash = hashEvent(rec);
    this.store.appendLine(JSON.stringify(rec));
    this.events.push(rec);
    if (type === 'revoke') this.revokedConsents.add(consentId);
    this.head = rec.hash;
    return rec;
  }

  leaves() {
    return this.events.map((e) => leafHash(e.hash));
  }

  // Seqs of historical events whose consent was later revoked. The events
  // stay in the log (facts are not erased) but are flagged restricted.
  restrictedSeqs() {
    const out = [];
    for (const e of this.events) {
      if (e.type !== 'revoke' && this.revokedConsents.has(e.consentId)) out.push(e.seq);
    }
    return out;
  }

  snapshot() {
    if (this.events.length === 0) {
      throw new ChainError(CODES.NO_PROOF, 'nothing to snapshot: chain is empty');
    }
    const manifest = {
      version: 1,
      seq: this.events.length - 1,
      leafCount: this.events.length,
      headHash: this.head,
      merkleRoot: merkleRoot(this.leaves()),
      createdAt: new Date().toISOString(),
    };
    this.store.writeManifestAtomic(manifest);
    this.manifest = manifest;
    return manifest;
  }

  challenge(index = null) {
    const n = this.events.length;
    if (n === 0) throw new ChainError(CODES.NO_PROOF, 'chain is empty: no proof available');
    const i = index === null || index === undefined ? randomInt(n) : Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= n) {
      throw new ChainError(CODES.NO_PROOF, `no proof for index ${i}: chain has ${n} events`, { index: i });
    }
    const proof = merkleProof(this.leaves(), i);
    return {
      index: i,
      eventSeq: this.events[i].seq,
      eventHash: this.events[i].hash,
      leaf: proof.leaf,
      path: proof.path,
      leafCount: n,
      root: proof.root,
    };
  }

  static verifyProof(proof) {
    return verifyProof(proof.leaf, proof.path, proof.root);
  }

  verify() {
    const head = validateChain(this.events);
    return {
      ok: true,
      eventCount: this.events.length,
      headHash: head,
      merkleRoot: this.events.length ? merkleRoot(this.leaves()) : null,
      restricted: this.restrictedSeqs(),
      revokedConsents: [...this.revokedConsents],
      manifest: this.manifest,
    };
  }
}
