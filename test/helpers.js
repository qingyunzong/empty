// Shared test helpers: seeded RNG and an INDEPENDENT brute-force evaluator
// used as ground truth for cross-checking the library.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

// Independent recursive claim evaluation.
// evidence: { id: { weight, active } }, claims: { id: { type, threshold, weight, refs: [] } }
// activeOnly: Set of evidence ids treated as active for this evaluation.
export function evalClaim(evidence, claims, id, activeOnly, visiting = []) {
  if (visiting.includes(id)) return { satisfied: false, error: 'E_CYCLE' };
  const claim = claims[id];
  if (!claim) return { satisfied: false, error: 'E_REF' };
  const next = [...visiting, id];
  let error = null;
  const parts = [];
  for (const ref of claim.refs) {
    if (evidence[ref]) {
      parts.push({ satisfied: activeOnly.has(ref), weight: evidence[ref].weight });
    } else if (claims[ref]) {
      const st = evalClaim(evidence, claims, ref, activeOnly, next);
      if (st.error && !error) error = st.error;
      parts.push({ satisfied: st.satisfied, weight: claims[ref].weight ?? 1 });
    } else {
      if (!error) error = 'E_REF';
      parts.push({ satisfied: false, weight: 0 });
    }
  }
  if (error) return { satisfied: false, error };
  let satisfied;
  if (claim.type === 'all') satisfied = parts.every((p) => p.satisfied);
  else if (claim.type === 'any') satisfied = parts.some((p) => p.satisfied);
  else {
    const threshold = Number.isFinite(claim.threshold) ? claim.threshold : 0;
    const sum = parts.filter((p) => p.satisfied).reduce((s, p) => s + p.weight, 0);
    satisfied = sum >= threshold;
  }
  return { satisfied, error: null };
}

// Ground truth: enumerate ALL evidence subsets, keep satisfying ones,
// pick minimum cardinality, then lexicographically smallest sorted id list.
export function bruteForceMinimalSupport(evidence, claims, claimId) {
  const activeIds = Object.keys(evidence)
    .filter((id) => evidence[id].active)
    .sort();
  let best = null;
  const total = 2 ** activeIds.length;
  for (let mask = 0; mask < total; mask++) {
    const subset = activeIds.filter((_, i) => (mask >> i) & 1);
    if (best && subset.length > best.length) continue;
    const st = evalClaim(evidence, claims, claimId, new Set(subset));
    if (st.error || !st.satisfied) continue;
    if (
      !best ||
      subset.length < best.length ||
      (subset.length === best.length && subset.join('|') < best.join('|'))
    ) {
      best = subset;
    }
  }
  return best;
}

// Convert an engine snapshot into the plain-object shape used by evalClaim.
export function snapshotToPlain(snapshot) {
  const evidence = {};
  for (const e of snapshot.evidence) evidence[e.id] = { weight: e.weight, active: e.active };
  const claims = {};
  for (const c of snapshot.claims) {
    claims[c.id] = { type: c.type, threshold: c.threshold, weight: c.weight, refs: c.refs };
  }
  return { evidence, claims };
}
