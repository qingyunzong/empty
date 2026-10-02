import { evalPred } from './algebra.js';
import { canonical, hashValue } from './canonical.js';
import { E, EvpackError } from './errors.js';

export const STATUSES = new Set(['asserted', 'retracted', 'unknown']);

// Evidence store with a per-rule inverted index: ruleId -> Set(evidenceKey).
// The index maps each rule to the keys whose fields satisfy the rule
// predicate; it is maintained per-key on insert and per-rule on rule add, so
// a retraction never triggers a full rescan of the evidence base.
export class Store {
  constructor() {
    this.rows = new Map(); // key -> { key, status, fields }
    this.rules = new Map(); // id -> { id, priority, when, ... }
    this.index = new Map(); // ruleId -> Set(key)
    this.scanCount = 0; // instrumentation: number of full evidence scans
  }

  addEvidence(row) {
    if (!row || typeof row.key !== 'string' || row.key === '') {
      throw new EvpackError('E_BAD_EVIDENCE', 'evidence row requires a string key');
    }
    if (!STATUSES.has(row.status)) {
      throw new EvpackError('E_BAD_EVIDENCE', `bad status for ${row.key}: ${row.status}`);
    }
    if (this.rows.has(row.key)) {
      throw new EvpackError('E_DUP_EVIDENCE', `duplicate evidence key: ${row.key}`);
    }
    const stored = { key: row.key, status: row.status, fields: row.fields ?? {} };
    this.rows.set(stored.key, stored);
    for (const [ruleId, rule] of this.rules) {
      if (evalPred(rule.when, stored.fields) === true) this.index.get(ruleId).add(stored.key);
    }
    return stored;
  }

  get(key) {
    return this.rows.get(key);
  }

  // O(1) status flip; the inverted index is field-based and untouched.
  retract(key) {
    const row = this.rows.get(key);
    if (!row || row.status === 'retracted') {
      throw new EvpackError(E.EVIDENCE_GONE, `evidence not available for retraction: ${key}`);
    }
    row.status = 'retracted';
    return row;
  }

  addRule(rule) {
    if (!rule || typeof rule.id !== 'string' || rule.id === '') {
      throw new EvpackError('E_BAD_RULE', 'rule requires a string id');
    }
    if (this.rules.has(rule.id)) {
      throw new EvpackError(E.DUP_RULE, `duplicate rule id: ${rule.id}`);
    }
    const stored = { priority: 0, ...rule, when: rule.when ?? { op: 'false' } };
    this.rules.set(stored.id, stored);
    const bucket = new Set();
    this.index.set(stored.id, bucket);
    this.scanCount += 1; // one full scan per added rule, never per retraction
    for (const row of this.rows.values()) {
      if (evalPred(stored.when, row.fields) === true) bucket.add(row.key);
    }
    return stored;
  }

  *all() {
    this.scanCount += 1;
    yield* this.rows.values();
  }

  get size() {
    return this.rows.size;
  }

  rulesMatching(key) {
    const out = [];
    for (const [ruleId, rule] of this.rules) {
      if (this.index.get(ruleId).has(key)) out.push(rule);
    }
    return out;
  }

  rulesVersion() {
    const rules = [...this.rules.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return hashValue(rules);
  }

  inputHash() {
    const rows = [...this.rows.values()]
      .map((r) => ({ key: r.key, status: r.status, fields: r.fields }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    return hashValue({ evidence: rows, rulesVersion: this.rulesVersion() });
  }

  toJSON() {
    return {
      evidence: [...this.rows.values()].map((r) => ({ ...r })),
      rules: [...this.rules.values()].map((r) => ({ ...r })),
    };
  }

  static fromJSON(obj) {
    const store = new Store();
    for (const row of obj.evidence ?? []) store.addEvidence(row);
    for (const rule of obj.rules ?? []) store.addRule(rule);
    return store;
  }
}

export function canonicalClaim(claim) {
  return JSON.parse(canonical(claim));
}
