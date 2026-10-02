'use strict';

const { createHash } = require('node:crypto');

const CLAIM_TYPES = new Set(['all', 'any', 'quorum']);

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function cmpId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Combine child results into a claim status.
function combine(claim, children, id) {
  const errored = children.filter((c) => c.state === 'error');
  const satisfied = children.filter((c) => c.state === 'satisfied');
  const value = satisfied.reduce((acc, c) => acc + c.weight, 0);

  const errorReasons = () => {
    const reasons = [];
    for (const c of errored) {
      reasons.push({ claim: id, code: c.error.code, via: c.ref });
      for (const r of c.reasons) reasons.push(r);
    }
    return reasons;
  };
  const asError = () => ({
    state: 'error',
    value,
    error: { code: errored[0].error.code },
    reasons: errorReasons(),
  });

  switch (claim.type) {
    case 'all': {
      if (errored.length) return asError();
      const missing = children.filter((c) => c.state !== 'satisfied');
      if (missing.length === 0) return { state: 'satisfied', value, reasons: [] };
      const reasons = [{ claim: id, rule: 'all', unsatisfied: missing.map((c) => c.ref) }];
      for (const c of missing) for (const r of c.reasons || []) reasons.push(r);
      return { state: 'unsatisfied', value, reasons };
    }
    case 'any': {
      if (satisfied.length) return { state: 'satisfied', value, reasons: [] };
      if (errored.length) return asError();
      return { state: 'unsatisfied', value, reasons: [{ claim: id, rule: 'any', satisfied: 0 }] };
    }
    case 'quorum': {
      if (errored.length) return asError();
      if (value >= claim.threshold) return { state: 'satisfied', value, reasons: [] };
      return {
        state: 'unsatisfied',
        value,
        reasons: [{ claim: id, rule: 'quorum', have: value, need: claim.threshold }],
      };
    }
    default:
      return { state: 'error', value, error: { code: 'E_TYPE' }, reasons: [{ claim: id, code: 'E_TYPE' }] };
  }
}

class Store {
  constructor() {
    this.evidence = new Map(); // id -> {id, weight, active}
    this.claims = new Map(); // id -> {id, type, threshold, weight, refs: []}
    this.dependents = new Map(); // targetId -> Set<claimId> (reverse edges)
    this.status = new Map(); // claimId -> committed status
    this.dirty = new Set(); // claimIds needing recompute
    this.opErrors = [];
    this.stats = { applied: 0, recomputed: 0 };
    this._passTargets = new Set();
    this._passMemo = new Map();
  }

  _dependentsOf(id) {
    let set = this.dependents.get(id);
    if (!set) {
      set = new Set();
      this.dependents.set(id, set);
    }
    return set;
  }

  // Mark a node and every claim transitively depending on it as dirty.
  _touch(id) {
    const queue = [id];
    const seen = new Set();
    while (queue.length) {
      const cur = queue.pop();
      if (this.claims.has(cur)) this.dirty.add(cur);
      if (seen.has(cur)) continue;
      seen.add(cur);
      const deps = this.dependents.get(cur);
      if (deps) for (const d of deps) queue.push(d);
    }
  }

  applyOp(op) {
    this.stats.applied += 1;
    switch (op.op) {
      case 'addEvidence': {
        this.evidence.set(op.id, {
          id: op.id,
          weight: num(op.weight, 1),
          active: op.active !== false,
        });
        this._touch(op.id);
        break;
      }
      case 'setWeight': {
        const ev = this.evidence.get(op.id) || { id: op.id, weight: 0, active: true };
        ev.weight = num(op.weight, ev.weight);
        this.evidence.set(op.id, ev);
        this._touch(op.id);
        break;
      }
      case 'retract':
      case 'restore': {
        const ev = this.evidence.get(op.id) || { id: op.id, weight: 0, active: true };
        ev.active = op.op === 'restore';
        this.evidence.set(op.id, ev);
        this._touch(op.id);
        break;
      }
      case 'addClaim': {
        if (!CLAIM_TYPES.has(op.type)) {
          this.opErrors.push({ op, error: 'E_TYPE' });
          return;
        }
        const existing = this.claims.get(op.id);
        if (existing) {
          existing.type = op.type;
          if (op.threshold !== undefined) existing.threshold = num(op.threshold, existing.threshold);
          if (op.weight !== undefined) existing.weight = num(op.weight, existing.weight);
        } else {
          this.claims.set(op.id, {
            id: op.id,
            type: op.type,
            threshold: num(op.threshold, op.type === 'quorum' ? 1 : 0),
            weight: num(op.weight, 1),
            refs: [],
          });
        }
        this._touch(op.id);
        break;
      }
      case 'addEdge': {
        const claim = this.claims.get(op.claim);
        if (!claim) {
          this.opErrors.push({ op, error: 'E_REF', detail: `unknown claim ${op.claim}` });
          return;
        }
        if (!claim.refs.includes(op.ref)) {
          claim.refs.push(op.ref); // idempotent: duplicate adds are no-ops
          this._dependentsOf(op.ref).add(op.claim);
          this._touch(op.claim);
        }
        break;
      }
      case 'removeEdge': {
        const claim = this.claims.get(op.claim);
        if (!claim) {
          this.opErrors.push({ op, error: 'E_REF', detail: `unknown claim ${op.claim}` });
          return;
        }
        const idx = claim.refs.indexOf(op.ref);
        if (idx >= 0) {
          claim.refs.splice(idx, 1);
          this._dependentsOf(op.ref).delete(op.claim);
          this._touch(op.claim);
        }
        break;
      }
      default:
        this.opErrors.push({ op, error: 'E_OP' });
    }
  }

  // Incrementally recompute only claims invalidated since the last settle.
  settle() {
    if (this.dirty.size === 0) return;
    this._passTargets = new Set(this.dirty);
    this.dirty.clear();
    this._passMemo = new Map();
    for (const id of this._passTargets) this._evalClaim(id, new Set());
    this._passMemo = new Map();
    this._passTargets = new Set();
  }

  _evalClaim(id, visiting) {
    if (this._passMemo.has(id)) return this._passMemo.get(id);
    const claim = this.claims.get(id);
    if (!claim) {
      return {
        state: 'error',
        value: 0,
        error: { code: 'E_REF', ref: id },
        reasons: [{ claim: id, code: 'E_REF', ref: id }],
      };
    }
    if (visiting.has(id)) {
      return {
        state: 'error',
        value: 0,
        error: { code: 'E_CYCLE', at: id },
        reasons: [{ claim: id, code: 'E_CYCLE' }],
      };
    }
    // Clean claims keep their committed status; only dirty subgraph recomputes.
    if (!this._passTargets.has(id) && this.status.has(id)) return this.status.get(id);

    visiting.add(id);
    const children = claim.refs.map((ref) => {
      if (this.evidence.has(ref)) {
        const ev = this.evidence.get(ref);
        return {
          ref,
          kind: 'evidence',
          state: ev.active ? 'satisfied' : 'unsatisfied',
          weight: ev.weight,
          reasons: ev.active ? [] : [{ evidence: ref, code: 'E_INACTIVE' }],
        };
      }
      if (this.claims.has(ref)) {
        const child = this._evalClaim(ref, visiting);
        return {
          ref,
          kind: 'claim',
          state: child.state,
          weight: this.claims.get(ref).weight,
          error: child.error,
          reasons: child.reasons,
        };
      }
      return {
        ref,
        kind: 'missing',
        state: 'error',
        weight: 0,
        error: { code: 'E_REF', ref },
        reasons: [{ claim: id, code: 'E_REF', ref }],
      };
    });
    visiting.delete(id);

    const status = combine(claim, children, id);
    this._passMemo.set(id, status);
    this.status.set(id, status);
    this.stats.recomputed += 1;
    return status;
  }
}

// --- minimal support evidence set -----------------------------------------

function betterSet(a, b) {
  // true if a is strictly better (smaller, then lexicographic) than b
  if (a.size !== b.size) return a.size < b.size;
  const as = [...a].sort().join('');
  const bs = [...b].sort().join('');
  return as < bs;
}

// Minimal set of currently-active evidence sufficient to satisfy `id`.
// Returns a Set of evidence ids, or null when unsatisfiable.
function minSupport(store, id, memo = new Map(), visiting = new Set()) {
  if (memo.has(id)) return memo.get(id);
  let result = null;
  if (store.evidence.has(id)) {
    result = store.evidence.get(id).active ? new Set([id]) : null;
  } else if (store.claims.has(id)) {
    const claim = store.claims.get(id);
    const status = store.status.get(id);
    if (visiting.has(id) || (status && status.state === 'error')) {
      result = null;
    } else {
      visiting.add(id);
      if (claim.type === 'all') {
        result = new Set();
        for (const ref of claim.refs) {
          const sub = minSupport(store, ref, memo, visiting);
          if (!sub) {
            result = null;
            break;
          }
          for (const x of sub) result.add(x);
        }
      } else if (claim.type === 'any') {
        for (const ref of claim.refs) {
          const sub = minSupport(store, ref, memo, visiting);
          if (sub && (!result || betterSet(sub, result))) result = sub;
        }
      } else {
        // quorum
        if (claim.threshold <= 0) {
          result = new Set();
        } else {
          const options = [];
          for (const ref of claim.refs) {
            const sub = minSupport(store, ref, memo, visiting);
            if (!sub) continue;
            const weight = store.evidence.has(ref)
              ? store.evidence.get(ref).weight
              : store.claims.get(ref).weight;
            options.push({ support: sub, weight });
          }
          const n = options.length;
          for (let mask = 1; mask < 1 << n; mask += 1) {
            let weightSum = 0;
            const union = new Set();
            for (let i = 0; i < n; i += 1) {
              if (mask & (1 << i)) {
                weightSum += options[i].weight;
                for (const x of options[i].support) union.add(x);
              }
            }
            if (weightSum >= claim.threshold && (!result || betterSet(union, result))) {
              result = union;
            }
          }
        }
      }
      visiting.delete(id);
    }
  }
  memo.set(id, result);
  return result;
}

// --- snapshots, hashing, certificates --------------------------------------

function canonicalState(store) {
  return {
    evidence: [...store.evidence.values()]
      .map((e) => ({ id: e.id, weight: e.weight, active: e.active }))
      .sort((a, b) => cmpId(a.id, b.id)),
    claims: [...store.claims.values()]
      .map((c) => ({
        id: c.id,
        type: c.type,
        threshold: c.threshold,
        weight: c.weight,
        refs: [...c.refs].sort(),
      }))
      .sort((a, b) => cmpId(a.id, b.id)),
    status: [...store.status.entries()]
      .map(([id, s]) => ({ id, state: s.state, value: s.value, error: s.error ? s.error.code : null }))
      .sort((a, b) => cmpId(a.id, b.id)),
  };
}

function stateHash(store) {
  return createHash('sha256').update(JSON.stringify(canonicalState(store))).digest('hex');
}

function snapshot(store) {
  store.settle();
  const claims = {};
  for (const c of store.claims.values()) {
    const st = store.status.get(c.id);
    claims[c.id] = {
      type: c.type,
      threshold: c.threshold,
      weight: c.weight,
      refs: [...c.refs],
      state: st.state,
      value: st.value,
      ...(st.error ? { error: st.error } : {}),
    };
  }
  const evidence = {};
  for (const e of store.evidence.values()) {
    evidence[e.id] = { weight: e.weight, active: e.active };
  }
  return {
    evidence,
    claims,
    opErrors: store.opErrors,
    stateHash: stateHash(store),
  };
}

function certificate(store, claimId) {
  store.settle();
  const hash = stateHash(store);
  if (!store.claims.has(claimId)) {
    return {
      claim: claimId,
      state: 'error',
      error: { code: 'E_REF', ref: claimId },
      support: null,
      reasons: [{ code: 'E_REF', ref: claimId }],
      stateHash: hash,
    };
  }
  const status = store.status.get(claimId);
  const support = minSupport(store, claimId);
  return {
    claim: claimId,
    state: status.state,
    ...(status.error ? { error: status.error } : {}),
    support: support ? [...support].sort() : null,
    reasons: status.reasons,
    stateHash: hash,
  };
}

module.exports = { Store, minSupport, stateHash, canonicalState, snapshot, certificate };
