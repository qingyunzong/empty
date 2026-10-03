// Append-only, revisioned evidence store for chargeback cases.
// Corrections append a new revision; revocations append a tombstone that
// carries a reversal (冲正) amount. Nothing is ever overwritten.

import { createHash } from 'node:crypto';
import { runQuery } from './query.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export class EvidenceStore {
  #records = []; // evidence versions + tombstones, in append order
  #cases = new Set();

  constructor(records = []) {
    for (const rec of records) this.#append(rec);
  }

  #append(rec) {
    this.#records.push(rec);
    this.#cases.add(rec.caseId);
  }

  get recordCount() {
    return this.#records.length;
  }

  hasCase(caseId) {
    return this.#cases.has(caseId);
  }

  #requireCase(caseId) {
    if (!this.#cases.has(caseId)) {
      throw new StoreError('UNKNOWN_CASE', `unknown case: ${caseId}`);
    }
  }

  #versionsOf(evidenceId) {
    return this.#records.filter((r) => r.kind === 'evidence' && r.id === evidenceId);
  }

  #latestVersion(evidenceId) {
    const versions = this.#versionsOf(evidenceId);
    return versions.length ? versions[versions.length - 1] : null;
  }

  addEvidence({ id, caseId, amount, text }) {
    if (id === undefined || id === null) throw new StoreError('INVALID_INPUT', 'id is required');
    if (typeof caseId !== 'string' || !caseId) {
      throw new StoreError('INVALID_INPUT', 'caseId is required');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new StoreError('INVALID_INPUT', 'amount must be a finite number');
    }
    if (typeof text !== 'string') throw new StoreError('INVALID_INPUT', 'text must be a string');
    if (this.#latestVersion(id)) {
      throw new StoreError('DUPLICATE_EVIDENCE', `evidence already exists: ${id}`);
    }
    const rec = { kind: 'evidence', id, caseId, amount, text, revision: 1, revoked: false };
    this.#append(rec);
    return { ...rec };
  }

  // Correction: append a new revision. If `revision` is given it must equal
  // the next sequential number; anything else is a regression (倒挂).
  correctEvidence(id, { amount, text, revision } = {}) {
    const latest = this.#latestVersion(id);
    if (!latest) throw new StoreError('UNKNOWN_EVIDENCE', `unknown evidence: ${id}`);
    const next = latest.revision + 1;
    if (revision !== undefined && (!Number.isInteger(revision) || revision !== next)) {
      throw new StoreError(
        'REVISION_REGRESSION',
        `revision regression: expected ${next}, got ${revision}`,
      );
    }
    const rec = {
      kind: 'evidence',
      id,
      caseId: latest.caseId,
      amount: amount ?? latest.amount,
      text: text ?? latest.text,
      revision: next,
      revoked: false,
    };
    this.#append(rec);
    return { ...rec };
  }

  // Revocation: mark the revision revoked and append a tombstone whose
  // reversal amount negates the revoked amount. Old revisions stay queryable.
  revokeRevision(id, revision) {
    const rec = this.#records.find(
      (r) => r.kind === 'evidence' && r.id === id && r.revision === revision,
    );
    if (!rec) {
      throw new StoreError('UNKNOWN_REVISION', `unknown revision: ${id}@${revision}`);
    }
    if (rec.revoked) {
      throw new StoreError('ALREADY_REVOKED', `already revoked: ${id}@${revision}`);
    }
    rec.revoked = true;
    const tombstone = {
      kind: 'tombstone',
      id,
      caseId: rec.caseId,
      revision,
      reversalAmount: -rec.amount,
    };
    this.#append(tombstone);
    return { ...tombstone };
  }

  // Latest non-revoked version per evidence within a case ("current" view).
  currentDocuments(caseId) {
    this.#requireCase(caseId);
    const byId = new Map();
    for (const r of this.#records) {
      if (r.kind !== 'evidence' || r.caseId !== caseId || r.revoked) continue;
      const prev = byId.get(r.id);
      if (!prev || r.revision > prev.revision) byId.set(r.id, r);
    }
    return [...byId.values()].map((r) => ({
      id: r.id,
      revision: r.revision,
      text: r.text,
      amount: r.amount,
    }));
  }

  // Historical view: for each evidence, the greatest revision <= `revision`,
  // regardless of later revocation (history is immutable).
  documentsAtRevision(caseId, revision) {
    this.#requireCase(caseId);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new StoreError('INVALID_INPUT', `invalid revision: ${revision}`);
    }
    const byId = new Map();
    for (const r of this.#records) {
      if (r.kind !== 'evidence' || r.caseId !== caseId || r.revision > revision) continue;
      const prev = byId.get(r.id);
      if (!prev || r.revision > prev.revision) byId.set(r.id, r);
    }
    return [...byId.values()].map((r) => ({
      id: r.id,
      revision: r.revision,
      text: r.text,
      amount: r.amount,
    }));
  }

  queryCurrent(caseId, query) {
    return runQuery(this.currentDocuments(caseId), query);
  }

  queryAtRevision(caseId, revision, query) {
    return runQuery(this.documentsAtRevision(caseId, revision), query);
  }

  currentAmount(caseId) {
    return this.currentDocuments(caseId).reduce((sum, d) => sum + d.amount, 0);
  }

  reversalAmount(caseId) {
    this.#requireCase(caseId);
    return this.#records
      .filter((r) => r.kind === 'tombstone' && r.caseId === caseId)
      .reduce((sum, r) => sum + r.reversalAmount, 0);
  }

  // Deterministic hash of the case's full record set (versions + tombstones).
  recordSetHash(caseId) {
    this.#requireCase(caseId);
    const rows = this.#records
      .filter((r) => r.caseId === caseId)
      .map((r) => ({ ...r }));
    const stable = JSON.stringify(
      rows.map((r) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)))),
    );
    return createHash('sha256').update(stable).digest('hex');
  }

  // Certificate: case, revision, hit positions, reversal amount, record-set hash.
  getCertificate(caseId, query) {
    this.#requireCase(caseId);
    const documents = this.currentDocuments(caseId);
    const { type, hits } = runQuery(documents, query);
    const revision = this.#records
      .filter((r) => r.caseId === caseId)
      .reduce((max, r) => Math.max(max, r.revision), 0);
    return {
      caseId,
      revision,
      query: { type, ...(query.phrase ? { phrase: query.phrase } : { near: query.near, slop: query.slop ?? 0 }) },
      hits,
      currentAmount: documents.reduce((sum, d) => sum + d.amount, 0),
      reversalAmount: this.reversalAmount(caseId),
      recordSetHash: this.recordSetHash(caseId),
    };
  }

  toJSON() {
    return { records: this.#records.map((r) => ({ ...r })) };
  }

  static fromJSON(data) {
    return new EvidenceStore(data?.records ?? []);
  }
}
