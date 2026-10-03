import { evaluate, claimWeight } from './graph.js';

const EXACT_LIMIT = 20; // active-evidence count cap for exact enumeration

// Certificate for a claim: minimal supporting evidence set when satisfied,
// rejection reason chain otherwise, plus the verifiable state hash.
export function certificate(engine, claimId) {
  const stateHash = engine.stateHash();
  if (!engine.claims.has(claimId)) {
    return {
      claimId,
      satisfied: false,
      error: 'E_REF',
      reasons: [{ node: claimId, code: 'E_REF', message: `unknown claim "${claimId}"` }],
      stateHash,
    };
  }
  const st = engine.statusOf(claimId);
  const cert = { claimId, satisfied: st.satisfied, error: st.error, stateHash };
  if (!st.error && st.satisfied) {
    cert.minimalSupport = minimalSupport(engine, claimId);
  } else {
    cert.reasons = [buildReason(engine, claimId, new Set())];
  }
  return cert;
}

// Minimum-cardinality set of active evidence ids that still satisfies the
// claim. Exact (subset enumeration, lexicographic tie-break) up to
// EXACT_LIMIT active evidence; structural greedy fallback beyond.
export function minimalSupport(engine, claimId) {
  const activeIds = [...engine.evidence]
    .filter(([, e]) => e.active)
    .map(([id]) => id)
    .sort();
  if (activeIds.length <= EXACT_LIMIT) {
    for (let k = 0; k <= activeIds.length; k++) {
      for (const subset of combinations(activeIds, k)) {
        if (satisfiesWith(engine, claimId, new Set(subset))) return subset;
      }
    }
    return null; // unreachable for a satisfied, error-free claim
  }
  return greedySupport(engine, claimId);
}

// Re-evaluate the claim with only the given evidence ids active.
export function satisfiesWith(engine, claimId, activeSet) {
  const ev = new Map(
    [...engine.evidence].map(([id, e]) => [id, { weight: e.weight, active: activeSet.has(id) }])
  );
  const cache = evaluate(ev, engine.claims, new Map(), [claimId]);
  const st = cache.get(claimId);
  return st != null && st.error == null && st.satisfied === true;
}

function* combinations(ids, k) {
  const n = ids.length;
  if (k < 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => ids[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// Greedy structural fallback for large evidence sets: pick per-node minimal
// supports bottom-up; for quorum, add satisfied children by weight desc.
function greedySupport(engine, claimId) {
  const memo = new Map();
  const support = (id, visiting) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return [];
    visiting.add(id);
    const claim = engine.claims.get(id);
    let result = [];
    if (claim) {
      const kids = [...claim.refs]
        .sort()
        .map((ref) => {
          if (engine.evidence.has(ref)) {
            const ev = engine.evidence.get(ref);
            return ev.active ? { refs: [ref], weight: ev.weight } : null;
          }
          if (engine.claims.has(ref)) {
            const st = engine.statusOf(ref);
            if (st.error || !st.satisfied) return null;
            return { refs: support(ref, visiting), weight: claimWeight(engine.claims.get(ref)) };
          }
          return null;
        })
        .filter(Boolean);
      if (claim.type === 'all') {
        result = unionAll(kids.map((k) => k.refs));
      } else if (claim.type === 'any') {
        kids.sort((a, b) => a.refs.length - b.refs.length);
        result = kids.length ? kids[0].refs : [];
      } else {
        const threshold = Number.isFinite(claim.threshold) ? claim.threshold : 0;
        kids.sort((a, b) => b.weight - a.weight);
        let sum = 0;
        const picked = [];
        for (const k of kids) {
          if (sum >= threshold) break;
          sum += k.weight;
          picked.push(k.refs);
        }
        result = unionAll(picked);
      }
    }
    visiting.delete(id);
    const sorted = [...new Set(result)].sort();
    memo.set(id, sorted);
    return sorted;
  };
  return support(claimId, new Set());
}

function unionAll(lists) {
  const out = [];
  for (const l of lists) out.push(...l);
  return out;
}

// Rejection reason chain: nested tree explaining why a claim fails.
export function buildReason(engine, id, seen) {
  const st = engine.statusOf(id);
  if (st.error === 'E_CYCLE' || seen.has(id)) {
    return { node: id, code: 'E_CYCLE', message: `claim "${id}" is part of a dependency cycle` };
  }
  seen.add(id);
  const claim = engine.claims.get(id);
  const children = [];
  let achieved = 0;
  for (const ref of [...claim.refs].sort()) {
    if (engine.evidence.has(ref)) {
      const ev = engine.evidence.get(ref);
      if (ev.active) {
        achieved += ev.weight;
      } else {
        children.push({ node: ref, code: 'E_INACTIVE', message: `evidence "${ref}" is retracted or inactive` });
      }
    } else if (engine.claims.has(ref)) {
      const cst = engine.statusOf(ref);
      if (cst.error) {
        children.push(buildReason(engine, ref, new Set(seen)));
      } else if (!cst.satisfied) {
        children.push(buildReason(engine, ref, new Set(seen)));
      } else {
        achieved += claimWeight(engine.claims.get(ref));
      }
    } else {
      children.push({ node: ref, code: 'E_REF', message: `unknown reference "${ref}"` });
    }
  }
  if (st.error === 'E_REF') {
    return { node: id, code: 'E_REF', message: `claim "${id}" references unknown node(s)`, children };
  }
  if (claim.type === 'all') {
    return { node: id, code: 'E_ALL', message: 'not all references are satisfied', children };
  }
  if (claim.type === 'any') {
    return { node: id, code: 'E_ANY', message: 'no reference is satisfied', children };
  }
  const threshold = Number.isFinite(claim.threshold) ? claim.threshold : 0;
  return {
    node: id,
    code: 'E_QUORUM',
    message: `satisfied weight ${achieved} below threshold ${threshold}`,
    detail: { achieved, threshold },
    children,
  };
}
