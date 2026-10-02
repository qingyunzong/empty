'use strict';

const EPS = 1e-9;

function toCents(amount) {
  return Math.round(amount * 100);
}

function ratioAmountCents(totalCents, ratio) {
  return Math.round((totalCents * ratio) / 100);
}

function capCents(center) {
  return center.cap == null ? Infinity : toCents(center.cap);
}

function minRatioOf(center) {
  return center.minRatio == null ? 0 : center.minRatio;
}

function maxRatioOf(center) {
  return center.maxRatio == null ? 100 : center.maxRatio;
}

// Build per-center ratio domains: allowed tiers intersected with
// [minRatio, maxRatio] and the audit cap (amount <= cap).
// A locked center collapses to a singleton (empty if the lock itself is illegal).
function buildDomains(centers, tiers, totalCents) {
  const domains = new Map();
  for (const center of centers) {
    let domain;
    if (center.lockedRatio != null) {
      const ratio = center.lockedRatio;
      const legal =
        ratio >= minRatioOf(center) - EPS &&
        ratio <= maxRatioOf(center) + EPS &&
        ratioAmountCents(totalCents, ratio) <= capCents(center);
      domain = legal ? [ratio] : [];
    } else {
      domain = tiers.filter(
        (t) =>
          t >= minRatioOf(center) - EPS &&
          t <= maxRatioOf(center) + EPS &&
          ratioAmountCents(totalCents, t) <= capCents(center)
      );
    }
    domains.set(center.id, domain);
  }
  return domains;
}

// Constraint propagation: delete ratios that can never reach sum=100 given the
// current min/max achievable sum of the other centers. Iterates to fixpoint.
function propagate(centers, domains, log) {
  let changed = true;
  while (changed) {
    changed = false;
    let sumMin = 0;
    let sumMax = 0;
    for (const center of centers) {
      const d = domains.get(center.id);
      if (d.length === 0) return false;
      sumMin += d[0];
      sumMax += d[d.length - 1];
    }
    for (const center of centers) {
      const d = domains.get(center.id);
      const othersMin = sumMin - d[0];
      const othersMax = sumMax - d[d.length - 1];
      const kept = d.filter((t) => {
        const rest = 100 - t;
        return rest >= othersMin - EPS && rest <= othersMax + EPS;
      });
      if (kept.length !== d.length) {
        const removed = d.filter((t) => !kept.includes(t));
        log({ type: 'propagate', center: center.id, removedRatios: removed });
        domains.set(center.id, kept);
        if (kept.length === 0) return false;
        changed = true;
      }
    }
  }
  return true;
}

// Depth-first backtracking over centers ordered by ascending domain size.
// `preferred` (Map center->ratio) is tried first so recomputes stay incremental
// and cancellations can restore the previous occupancy.
function search(centers, domains, budget, preferred, log) {
  const order = centers
    .slice()
    .sort((a, b) => domains.get(a.id).length - domains.get(b.id).length);
  const assignment = new Map();
  let nodes = 0;
  let exceeded = false;

  function dfs(idx, sumSoFar) {
    if (idx === order.length) return Math.abs(sumSoFar - 100) <= EPS;
    nodes += 1;
    if (nodes > budget) {
      exceeded = true;
      return false;
    }
    const center = order[idx];
    let values = domains.get(center.id).slice();
    const pref = preferred && preferred.get(center.id);
    if (pref != null && values.includes(pref)) {
      values = [pref, ...values.filter((v) => v !== pref)];
    }
    let restMin = 0;
    let restMax = 0;
    for (let j = idx + 1; j < order.length; j += 1) {
      const dj = domains.get(order[j].id);
      restMin += dj[0];
      restMax += dj[dj.length - 1];
    }
    for (const v of values) {
      const newSum = sumSoFar + v;
      if (newSum + restMin > 100 + EPS) continue;
      if (newSum + restMax < 100 - EPS) continue;
      assignment.set(center.id, v);
      log({ type: 'assign', center: center.id, ratio: v });
      if (dfs(idx + 1, newSum)) return true;
      assignment.delete(center.id);
      log({ type: 'backtrack', center: center.id, ratio: v });
      if (exceeded) return false;
    }
    return false;
  }

  const ok = dfs(0, 0);
  return { ok, exceeded, assignment, nodes };
}

// Minimal conflicting center set: smallest subset S such that the instance is
// infeasible even when every center outside S is left completely free ([0,100]).
// Computed by greedy deletion over a bounds feasibility check.
function conflictCore(centers, domains) {
  const stats = centers.map((c) => {
    const d = domains.get(c.id);
    return {
      id: c.id,
      min: d.length ? d[0] : Infinity,
      max: d.length ? d[d.length - 1] : -Infinity,
    };
  });
  const infeasible = (set) => {
    let sumMin = 0;
    let sumMax = 0;
    for (const s of set) {
      sumMin += s.min;
      sumMax += s.max;
    }
    const rest = stats.length - set.length;
    return !(sumMin <= 100 + EPS && sumMax + 100 * rest >= 100 - EPS);
  };
  if (!infeasible(stats)) {
    // Bounds look feasible but the discrete search failed: every center matters.
    return centers.map((c) => c.id);
  }
  let core = stats.slice();
  for (const s of core.slice()) {
    const trial = core.filter((x) => x !== s);
    if (trial.length > 0 && infeasible(trial)) core = trial;
  }
  return core.map((s) => s.id);
}

// Solve one allocation layer.
// centers: [{id, minRatio?, maxRatio?, cap?, lockedRatio?}]
// Returns { status: 'OK'|'UNSAT'|'PENDING', assignment?, conflictCenters?, nodes }.
// Search-node budget exhaustion yields PENDING, never UNSAT.
function solve({ centers, tiers, totalAmount, budget = 100000, preferred = null, log = () => {} }) {
  const totalCents = toCents(totalAmount);
  const sortedTiers = tiers.slice().sort((a, b) => a - b);
  const domains = buildDomains(centers, sortedTiers, totalCents);
  // Snapshot of the raw (pre-propagation) domains: the conflict core is
  // computed from these so it reflects the input constraints, not the
  // order in which propagation happened to empty a domain.
  const rawDomains = new Map([...domains].map(([id, d]) => [id, d.slice()]));

  for (const center of centers) {
    if (domains.get(center.id).length === 0) {
      log({ type: 'domain-empty', center: center.id });
      return { status: 'UNSAT', conflictCenters: conflictCore(centers, rawDomains), nodes: 0 };
    }
  }

  if (!propagate(centers, domains, log)) {
    const empty = centers.find((c) => domains.get(c.id).length === 0);
    log({ type: 'domain-empty', center: empty ? empty.id : null });
    return { status: 'UNSAT', conflictCenters: conflictCore(centers, rawDomains), nodes: 0 };
  }

  const { ok, exceeded, assignment, nodes } = search(centers, domains, budget, preferred, log);
  if (ok) {
    log({ type: 'solution', ratios: Object.fromEntries(assignment), nodes });
    return { status: 'OK', assignment, nodes };
  }
  if (exceeded) {
    log({ type: 'budget-exceeded', budget, nodes });
    return { status: 'PENDING', nodes };
  }
  log({ type: 'unsat', nodes });
  return { status: 'UNSAT', conflictCenters: conflictCore(centers, rawDomains), nodes };
}

module.exports = { solve, toCents, ratioAmountCents, EPS };
