import { evaluate } from './graph.js';
import { hashValue } from './canon.js';

const CLAIM_TYPES = new Set(['all', 'any', 'quorum']);

// Incremental engine: applies Lamport-ordered ops, keeps evidence/claim
// state, and lazily recomputes only the claims affected by each mutation
// (dirty-set propagation along reverse dependency edges).
export class Engine {
  constructor() {
    this.evidence = new Map(); // id -> { weight, active }
    this.claims = new Map(); // id -> { type, threshold, weight, refs:Set }
    this.dependents = new Map(); // nodeId -> Set<claimId> (reverse edges)
    this.status = new Map(); // claimId -> { satisfied, error } (cache)
    this.applied = 0;
    this.opErrors = [];
  }

  applyAll(ops) {
    for (const op of ops) this.apply(op);
    return this;
  }

  apply(op) {
    const index = this.applied;
    this.applied += 1;
    const fail = (reason) => this.opErrors.push({ index, op, reason });
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
      return fail('malformed op');
    }
    switch (op.op) {
      case 'addEvidence': {
        if (!isId(op.id) || !Number.isFinite(op.weight)) return fail('addEvidence needs id and numeric weight');
        this.evidence.set(op.id, { weight: op.weight, active: true });
        this.#dirty(op.id);
        return;
      }
      case 'retractEvidence': {
        if (!isId(op.id)) return fail('retractEvidence needs id');
        const ev = this.evidence.get(op.id);
        if (ev && ev.active) {
          ev.active = false;
          this.#dirty(op.id);
        }
        return;
      }
      case 'defineClaim': {
        if (!isId(op.id) || !CLAIM_TYPES.has(op.type)) return fail('defineClaim needs id and type all|any|quorum');
        if (op.threshold !== undefined && !Number.isFinite(op.threshold)) return fail('threshold must be numeric');
        if (op.weight !== undefined && !Number.isFinite(op.weight)) return fail('weight must be numeric');
        const existing = this.claims.get(op.id);
        if (existing) {
          existing.type = op.type;
          existing.threshold = op.threshold;
          existing.weight = op.weight;
        } else {
          this.claims.set(op.id, {
            type: op.type,
            threshold: op.threshold,
            weight: op.weight,
            refs: new Set(),
          });
        }
        this.#dirty(op.id);
        return;
      }
      case 'addEdge': {
        if (!isId(op.claim) || !isId(op.ref)) return fail('addEdge needs claim and ref');
        const claim = this.claims.get(op.claim);
        if (!claim) return fail(`unknown claim "${op.claim}"`);
        if (claim.refs.has(op.ref)) return; // idempotent re-add
        claim.refs.add(op.ref);
        addToMapSet(this.dependents, op.ref, op.claim);
        this.#dirty(op.claim);
        return;
      }
      case 'removeEdge': {
        if (!isId(op.claim) || !isId(op.ref)) return fail('removeEdge needs claim and ref');
        const claim = this.claims.get(op.claim);
        if (!claim) return fail(`unknown claim "${op.claim}"`);
        if (!claim.refs.has(op.ref)) return; // idempotent remove
        claim.refs.delete(op.ref);
        const set = this.dependents.get(op.ref);
        if (set) set.delete(op.claim);
        this.#dirty(op.claim);
        return;
      }
      default:
        return fail(`unknown op "${op.op}"`);
    }
  }

  // Clear cached status for every claim that transitively depends on nodeId.
  #dirty(nodeId) {
    if (this.claims.has(nodeId)) this.status.delete(nodeId);
    const queue = [nodeId];
    const seen = new Set([nodeId]);
    while (queue.length) {
      const cur = queue.pop();
      const parents = this.dependents.get(cur);
      if (!parents) continue;
      for (const p of parents) {
        if (seen.has(p)) continue;
        seen.add(p);
        this.status.delete(p);
        queue.push(p);
      }
    }
  }

  statusOf(claimId) {
    evaluate(this.evidence, this.claims, this.status, [claimId]);
    return this.status.get(claimId);
  }

  snapshot() {
    evaluate(this.evidence, this.claims, this.status);
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
      evidence: [...this.evidence]
        .map(([id, e]) => ({ id, weight: e.weight, active: e.active }))
        .sort(byId),
      claims: [...this.claims]
        .map(([id, c]) => ({
          id,
          type: c.type,
          threshold: c.threshold ?? null,
          weight: c.weight ?? 1,
          refs: [...c.refs].sort(),
        }))
        .sort(byId),
      statuses: [...this.claims.keys()]
        .sort()
        .map((id) => ({ id, satisfied: this.status.get(id).satisfied, error: this.status.get(id).error })),
      applied: this.applied,
      opErrors: this.opErrors,
    };
  }

  stateHash() {
    // The hash commits to the logical state only: op counts and opErrors
    // are history artifacts and must not affect verifiability/idempotency.
    const { evidence, claims, statuses } = this.snapshot();
    return hashValue({ evidence, claims, statuses });
  }
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function addToMapSet(map, key, value) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}
