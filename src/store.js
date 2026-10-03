// Append-only evidence store: cases, evidence revisions, tombstones.
// Corrections append a new revision; revocation appends a tombstone that
// carries a reversal (冲正) amount. Nothing is ever overwritten.

import { searchDocs } from './index.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export function createStore() {
  return { seq: 0, records: [], cases: new Map() };
}

function applyRecord(store, rec) {
  if (rec.type === 'case') {
    store.cases.set(rec.caseId, { caseId: rec.caseId, evidences: new Map() });
  } else if (rec.type === 'evidence') {
    const kase = store.cases.get(rec.caseId);
    if (!kase.evidences.has(rec.id)) {
      kase.evidences.set(rec.id, { id: rec.id, caseId: rec.caseId, revisions: new Map(), revoked: new Set() });
    }
    kase.evidences.get(rec.id).revisions.set(rec.revision, rec);
  } else if (rec.type === 'tombstone') {
    store.cases.get(rec.caseId).evidences.get(rec.id).revoked.add(rec.revision);
  }
  store.records.push(rec);
  store.seq = Math.max(store.seq, rec.seq + 1);
}

export function hydrateStore(records) {
  const store = createStore();
  for (const rec of records) applyRecord(store, rec);
  return store;
}

function append(store, rec) {
  applyRecord(store, { ...rec, seq: store.seq });
  return store.records[store.records.length - 1];
}

export function registerCase(store, caseId) {
  if (store.cases.has(caseId)) {
    throw new StoreError('ERR_CASE_EXISTS', `case already exists: ${caseId}`);
  }
  return append(store, { type: 'case', caseId });
}

export function getCase(store, caseId) {
  const kase = store.cases.get(caseId);
  if (!kase) throw new StoreError('ERR_UNKNOWN_CASE', `unknown case: ${caseId}`);
  return kase;
}

export function addEvidence(store, { id, caseId, amount, text, revision }) {
  const kase = getCase(store, caseId);
  const ev = kase.evidences.get(id);
  const latest = ev ? Math.max(...ev.revisions.keys()) : 0;
  if (revision <= latest) {
    throw new StoreError(
      'ERR_REVISION_REGRESSION',
      `revision ${revision} does not move forward (latest is ${latest}) for evidence ${id}`,
    );
  }
  if (revision !== latest + 1) {
    throw new StoreError(
      'ERR_REVISION_GAP',
      `revision ${revision} skips ahead (expected ${latest + 1}) for evidence ${id}`,
    );
  }
  return append(store, { type: 'evidence', id, caseId, amount, text, revision });
}

export function revokeRevision(store, caseId, id, revision) {
  const kase = getCase(store, caseId);
  const ev = kase.evidences.get(id);
  if (!ev) throw new StoreError('ERR_UNKNOWN_EVIDENCE', `unknown evidence: ${id}`);
  const target = ev.revisions.get(revision);
  if (!target) {
    throw new StoreError('ERR_UNKNOWN_REVISION', `evidence ${id} has no revision ${revision}`);
  }
  if (ev.revoked.has(revision)) {
    throw new StoreError('ERR_ALREADY_REVOKED', `evidence ${id} revision ${revision} already revoked`);
  }
  return append(store, {
    type: 'tombstone',
    id,
    caseId,
    revision,
    reversalAmount: -target.amount,
  });
}

export function getEvidence(store, caseId, id, revision) {
  const kase = getCase(store, caseId);
  const ev = kase.evidences.get(id);
  if (!ev) throw new StoreError('ERR_UNKNOWN_EVIDENCE', `unknown evidence: ${id}`);
  const rec = revision === undefined
    ? ev.revisions.get(Math.max(...ev.revisions.keys()))
    : ev.revisions.get(revision);
  if (!rec) throw new StoreError('ERR_UNKNOWN_REVISION', `evidence ${id} has no revision ${revision}`);
  return rec;
}

// Latest non-revoked revision per evidence (the "current" view).
export function currentDocuments(store, caseId) {
  const kase = getCase(store, caseId);
  const docs = [];
  for (const ev of kase.evidences.values()) {
    const live = [...ev.revisions.keys()].filter((r) => !ev.revoked.has(r));
    if (live.length === 0) continue;
    const rev = Math.max(...live);
    const rec = ev.revisions.get(rev);
    docs.push({ key: rec.id, revision: rec.revision, text: rec.text, amount: rec.amount });
  }
  return docs;
}

// Greatest revision <= revision per evidence, ignoring tombstones (history view).
export function historicalDocuments(store, caseId, revision) {
  const kase = getCase(store, caseId);
  const docs = [];
  for (const ev of kase.evidences.values()) {
    const eligible = [...ev.revisions.keys()].filter((r) => r <= revision);
    if (eligible.length === 0) continue;
    const rec = ev.revisions.get(Math.max(...eligible));
    docs.push({ key: rec.id, revision: rec.revision, text: rec.text, amount: rec.amount });
  }
  return docs;
}

export function caseAmounts(store, caseId) {
  const kase = getCase(store, caseId);
  const currentAmount = currentDocuments(store, caseId).reduce((s, d) => s + d.amount, 0);
  let reversalAmount = 0;
  for (const rec of store.records) {
    if (rec.type === 'tombstone' && rec.caseId === caseId) reversalAmount += rec.reversalAmount;
  }
  return { caseId: kase.caseId, currentAmount, reversalAmount };
}

export function maxRevision(store, caseId) {
  const kase = getCase(store, caseId);
  let max = 0;
  for (const ev of kase.evidences.values()) {
    for (const r of ev.revisions.keys()) if (r > max) max = r;
  }
  return max;
}

// query: { type: 'phrase'|'near', terms, slop? }; opts.revision => historical view.
export function search(store, caseId, query, opts = {}) {
  const docs = opts.revision !== undefined
    ? historicalDocuments(store, caseId, opts.revision)
    : currentDocuments(store, caseId);
  return searchDocs(docs, query);
}
