// Pure claim-graph evaluation with cycle and unknown-reference detection.
// evidence: Map id -> { weight, active }
// claims:   Map id -> { type: 'all'|'any'|'quorum', threshold, weight, refs: Set }
// Returns the shared cache Map: claimId -> { satisfied, error } where
// error is null, 'E_CYCLE' or 'E_REF'. Errors propagate to dependents.

export function claimWeight(claim) {
  return Number.isFinite(claim.weight) ? claim.weight : 1;
}

function satisfies(claim, parts) {
  switch (claim.type) {
    case 'all':
      return parts.every((p) => p.satisfied);
    case 'any':
      return parts.some((p) => p.satisfied);
    case 'quorum': {
      const threshold = Number.isFinite(claim.threshold) ? claim.threshold : 0;
      let sum = 0;
      for (const p of parts) if (p.satisfied) sum += p.weight;
      return sum >= threshold;
    }
    default:
      return false;
  }
}

export function evaluate(evidence, claims, cache = new Map(), roots = null) {
  const stack = [];

  const visit = (id) => {
    const hit = cache.get(id);
    if (hit) return hit;
    const at = stack.indexOf(id);
    if (at !== -1) {
      const st = { satisfied: false, error: 'E_CYCLE' };
      for (let i = at; i < stack.length; i++) cache.set(stack[i], st);
      return st;
    }
    const claim = claims.get(id);
    if (!claim) {
      const st = { satisfied: false, error: 'E_REF' };
      cache.set(id, st);
      return st;
    }
    stack.push(id);
    let error = null;
    const parts = [];
    for (const ref of [...claim.refs].sort()) {
      if (evidence.has(ref)) {
        const ev = evidence.get(ref);
        parts.push({ satisfied: ev.active === true, weight: ev.weight });
      } else if (claims.has(ref)) {
        const st = visit(ref);
        if (st.error && !error) error = st.error;
        parts.push({ satisfied: st.satisfied, weight: claimWeight(claims.get(ref)) });
      } else {
        if (!error) error = 'E_REF';
        parts.push({ satisfied: false, weight: 0 });
      }
    }
    stack.pop();
    const st = error
      ? { satisfied: false, error }
      : { satisfied: satisfies(claim, parts), error: null };
    cache.set(id, st);
    return st;
  };

  for (const id of roots ?? claims.keys()) visit(id);
  return cache;
}
