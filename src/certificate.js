// Query certificates: bind a query result to the case, revision, hit
// positions, reversal amount and a hash of the case's record set.

import { createHash } from 'node:crypto';
import { search, caseAmounts, maxRevision, getCase } from './store.js';

export function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

// sha256 over the case's records (in append order), canonically serialized.
export function recordSetHash(store, caseId) {
  getCase(store, caseId);
  const recs = store.records.filter((r) => r.caseId === caseId);
  return createHash('sha256').update(canonicalize(recs), 'utf8').digest('hex');
}

export function issueCertificate(store, caseId, query, opts = {}) {
  const hits = search(store, caseId, query, opts);
  const { currentAmount, reversalAmount } = caseAmounts(store, caseId);
  const revision = opts.revision !== undefined ? opts.revision : maxRevision(store, caseId);
  return {
    caseId,
    revision,
    query: {
      type: query.type,
      terms: query.terms.map((t) => t.toLowerCase()),
      slop: query.type === 'near' ? (query.slop ?? 0) : undefined,
    },
    hits,
    currentAmount,
    reversalAmount,
    recordSetHash: recordSetHash(store, caseId),
  };
}
