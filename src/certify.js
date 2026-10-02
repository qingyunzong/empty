'use strict';

// Certification engine.
//
// Decision semantics:
//   CERT                  a valid traceability chain exists, evidence complete,
//                         combined uncertainty comfortably within budget.
//   REFUTE                a hard contradiction is proven (broken chain, cycle,
//                         uncertainty inversion, expired standard, domain
//                         mismatch, env reading outside window, budget clearly
//                         exceeded). Carries a deletion-minimal core.
//   INSUFFICIENT_EVIDENCE evidence is missing (no measurement, no env window,
//                         no env reading, no traceability links, dangling
//                         link targets). Never reported as REFUTE.
//   PENDING               decision cannot be finalized yet: combined
//                         uncertainty inside the budget boundary band, or all
//                         acceptable chains are blocked by leases.

const { LabError } = require('./errors.js');
const { hashObject } = require('./hash.js');

const DEFAULT_MARGIN = 0.05;

function linkKey(l) {
  return `${l.from}->${l.to}`;
}

function latestMeasurement(state, pointId) {
  let found = null;
  for (const m of state.measurements) if (m.pointId === pointId) found = m;
  return found;
}

function inWindow(meas, window) {
  return (
    meas.temp >= window.tempMin &&
    meas.temp <= window.tempMax &&
    meas.humidity >= window.humMin &&
    meas.humidity <= window.humMax
  );
}

function combineUncertainty(state, chain, meas) {
  const uMeas = meas && typeof meas.uMeas === 'number' ? meas.uMeas : 0;
  let acc = uMeas * uMeas;
  for (const id of chain.path.slice(1)) {
    const u = state.artifacts[id].uncertainty;
    acc += u * u;
  }
  return Math.sqrt(acc);
}

// Chain exploration. With `prune: true` this is the backtracking solver:
// constraint violations prune the subtree immediately. With `prune: false`
// it is the naive enumerator used for cross-checking: all simple paths are
// walked and evaluated as a whole. Both must yield the same valid chains.
function explore(state, point, uut, at, { prune }) {
  const adj = new Map();
  for (const l of state.links) {
    if (!adj.has(l.from)) adj.set(l.from, []);
    adj.get(l.from).push(l.to);
  }
  const chains = [];
  const violations = [];
  const gaps = [];
  const seenCycles = new Set();
  const atMs = Date.parse(at);

  const uutEdges = adj.get(uut.id) || [];
  if (uutEdges.length === 0) {
    gaps.push({ type: 'NO_TRACEABILITY_LINK', uut: uut.id });
    return { chains, violations, gaps };
  }

  function stepViolations(spec, prevSpec, toId) {
    const v = [];
    if (spec.rangeClass !== point.rangeClass) {
      v.push({ type: 'RANGE_MISMATCH', target: toId, expected: point.rangeClass, actual: spec.rangeClass });
    }
    if (spec.envClass !== point.envClass) {
      v.push({ type: 'ENV_CLASS_MISMATCH', target: toId, expected: point.envClass, actual: spec.envClass });
    }
    if (point.grade && spec.grade && spec.grade !== point.grade) {
      v.push({ type: 'GRADE_MISMATCH', target: toId, expected: point.grade, actual: spec.grade });
    }
    const bar = prevSpec.kind === 'uut' ? point.budget : prevSpec.uncertainty;
    if (typeof spec.uncertainty !== 'number' || !(spec.uncertainty < bar)) {
      v.push({ type: 'UNCERTAINTY_INVERSION', target: toId, uncertainty: spec.uncertainty, requiredBelow: bar });
    }
    if (spec.validFrom && atMs < Date.parse(spec.validFrom)) {
      v.push({ type: 'NOT_YET_VALID', target: toId, validFrom: spec.validFrom });
    }
    if (spec.validTo && atMs > Date.parse(spec.validTo)) {
      v.push({ type: 'EXPIRED', target: toId, validTo: spec.validTo });
    }
    return v;
  }

  function dfs(currentId, path, visited, bad) {
    const nexts = adj.get(currentId) || [];
    for (const to of nexts) {
      if (visited.has(to)) {
        const cyc = [...path.slice(path.indexOf(to)), to];
        const key = cyc.join('>');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          violations.push({ type: 'CYCLE', path: cyc });
        }
        continue;
      }
      const spec = state.artifacts[to];
      if (!spec) {
        gaps.push({ type: 'DANGLING_LINK', from: currentId, to });
        continue;
      }
      const sv = stepViolations(spec, state.artifacts[currentId], to);
      if (sv.length > 0) {
        for (const v of sv) violations.push({ ...v, path: [...path, to] });
        if (prune) continue;
      }
      const badNext = bad || sv.length > 0;
      if (spec.root) {
        if (!badNext) chains.push({ path: [...path, to] });
        continue; // roots terminate a traceability chain
      }
      visited.add(to);
      path.push(to);
      dfs(to, path, visited, badNext);
      path.pop();
      visited.delete(to);
    }
    if (currentId !== uut.id) {
      const spec = state.artifacts[currentId];
      const hasOutgoing = (adj.get(currentId) || []).length > 0;
      if (!hasOutgoing && spec && !spec.root) {
        violations.push({ type: 'BROKEN_CHAIN', path: [...path], terminal: currentId });
      }
    }
  }

  dfs(uut.id, [uut.id], new Set([uut.id]), false);
  return { chains, violations, gaps };
}

function buildCert(state, point, meas, chain, margin, at) {
  const standards = chain.path.slice(1).map((id) => state.artifacts[id]);
  const uut = state.artifacts[point.uutId];
  const links = [];
  for (let i = 0; i + 1 < chain.path.length; i += 1) {
    links.push({ from: chain.path[i], to: chain.path[i + 1] });
  }
  // Snapshot the inputs so later lab edits cannot alias into the certificate.
  const inputs = structuredClone({
    point,
    uut,
    standards,
    links,
    measurement: meas,
  });
  const body = {
    pointId: point.id,
    at,
    decision: 'CERT',
    chain: [...chain.path].reverse(), // root ... uut
    combinedUncertainty: chain.combinedUncertainty,
    budget: point.budget,
    margin,
    inputs,
  };
  const hash = hashObject(body);
  return { id: `CERT-${hash.slice(0, 16)}`, ...body, hash };
}

// Rebuild a minimal lab view from a core fact set.
function labFromCore(lab, core) {
  const s = lab.state;
  const artifacts = {};
  for (const id of core.artifacts) if (s.artifacts[id]) artifacts[id] = s.artifacts[id];
  const keys = new Set(core.links.map(linkKey));
  return {
    state: {
      artifacts,
      links: s.links.filter((l) => keys.has(linkKey(l))),
      leases: s.leases,
      certs: {},
      measurements: core.measurement ? s.measurements.filter((m) => m.id === core.measurement) : [],
    },
  };
}

// Deletion-minimal refutation core: context (point, uut, latest measurement)
// plus the smallest subset of traceability facts (standards, links) that still
// refutes with one of the original violation types.
function minimizeCore(lab, pointId, at, violations) {
  const state = lab.state;
  const point = state.artifacts[pointId];
  const meas = latestMeasurement(state, pointId);
  const types = new Set(violations.map((v) => v.type));
  const context = new Set([pointId]);
  if (point.uutId) context.add(point.uutId);

  const reachableArts = new Set();
  const reachableLinks = [];
  if (point.uutId && state.artifacts[point.uutId]) {
    const seen = new Set([point.uutId]);
    const queue = [point.uutId];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const l of state.links) {
        if (l.from !== cur) continue;
        reachableLinks.push(l);
        if (!seen.has(l.to)) {
          seen.add(l.to);
          queue.push(l.to);
        }
      }
    }
    for (const id of seen) if (!context.has(id)) reachableArts.add(id);
  }

  const keepArts = new Set([...context, ...reachableArts]);
  const keepLinks = new Set(reachableLinks.map(linkKey));

  const stillRefutes = () => {
    const sub = labFromCore(lab, {
      artifacts: [...keepArts],
      links: state.links.filter((l) => keepLinks.has(linkKey(l))),
      measurement: meas ? meas.id : null,
    });
    const r = evaluate(sub, pointId, at, { skipCore: true });
    return r.status === 'REFUTE' && r.violations.some((v) => types.has(v.type));
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...reachableArts]) {
      if (!keepArts.has(id)) continue;
      keepArts.delete(id);
      if (stillRefutes()) changed = true;
      else keepArts.add(id);
    }
    for (const l of reachableLinks) {
      const key = linkKey(l);
      if (!keepLinks.has(key)) continue;
      keepLinks.delete(key);
      if (stillRefutes()) changed = true;
      else keepLinks.add(key);
    }
  }

  return {
    artifacts: [...keepArts],
    links: state.links.filter((l) => keepLinks.has(linkKey(l))),
    measurement: meas ? meas.id : null,
    violationTypes: [...types],
  };
}

function evaluate(lab, pointId, at, opts = {}) {
  const prune = opts.prune !== false;
  const state = lab.state;
  const point = state.artifacts[pointId];
  if (!point || point.kind !== 'point') {
    throw new LabError('NO_SUCH_POINT', `no such measurement point: ${pointId}`);
  }
  const margin = point.margin !== undefined ? point.margin : DEFAULT_MARGIN;

  const hard = [];
  const uut = state.artifacts[point.uutId];
  if (!uut) hard.push({ type: 'DANGLING_UUT', target: point.uutId });

  const meas = latestMeasurement(state, pointId);
  const measGaps = [];
  if (!meas) measGaps.push({ type: 'NO_MEASUREMENT', point: pointId });
  if (!point.window) {
    measGaps.push({ type: 'NO_ENV_WINDOW', point: pointId });
  } else if (meas && (meas.temp === null || meas.temp === undefined || meas.humidity === null || meas.humidity === undefined)) {
    measGaps.push({ type: 'NO_ENV_READING', point: pointId });
  } else if (meas && !inWindow(meas, point.window)) {
    hard.push({
      type: 'ENV_OUT_OF_WINDOW',
      window: point.window,
      reading: { temp: meas.temp, humidity: meas.humidity },
    });
  }

  let chains = [];
  let chainViolations = [];
  let chainGaps = [];
  if (uut) {
    const r = explore(state, point, uut, at, { prune });
    chains = r.chains;
    chainViolations = r.violations;
    chainGaps = r.gaps;
  }

  const finishRefute = (violations) => {
    const result = { status: 'REFUTE', violations };
    if (!opts.skipCore) result.core = minimizeCore(lab, pointId, at, violations);
    return result;
  };

  if (hard.length > 0) return finishRefute(hard);

  if (chains.length === 0) {
    if (chainViolations.length > 0) return finishRefute(chainViolations);
    return { status: 'INSUFFICIENT_EVIDENCE', missing: [...measGaps, ...chainGaps] };
  }

  if (measGaps.length > 0) return { status: 'INSUFFICIENT_EVIDENCE', missing: measGaps };

  for (const c of chains) {
    c.busy = c.path.slice(1).some((id) => Boolean(state.leases[id]));
    c.combinedUncertainty = combineUncertainty(state, c, meas);
  }

  const budget = point.budget;
  const classify = (u) => {
    if (u < budget * (1 - margin)) return 'OK';
    if (u <= budget * (1 + margin)) return 'BAND';
    return 'OVER';
  };
  const best = (arr) => arr.reduce((a, b) => (a.combinedUncertainty <= b.combinedUncertainty ? a : b));
  const ok = chains.filter((c) => classify(c.combinedUncertainty) === 'OK');
  const band = chains.filter((c) => classify(c.combinedUncertainty) === 'BAND');

  const okFree = ok.filter((c) => !c.busy);
  if (okFree.length > 0) {
    const chain = best(okFree);
    const cert = buildCert(state, point, meas, chain, margin, at);
    return { status: 'CERT', cert, chain: cert.chain, combinedUncertainty: cert.combinedUncertainty };
  }

  const bandFree = band.filter((c) => !c.busy);
  if (bandFree.length > 0) {
    const chain = best(bandFree);
    return {
      status: 'PENDING',
      reason: 'BUDGET_BOUNDARY',
      chain: [...chain.path].reverse(),
      combinedUncertainty: chain.combinedUncertainty,
      budget,
      margin,
    };
  }

  if (ok.length > 0 || band.length > 0) {
    const chain = best([...ok, ...band]);
    return {
      status: 'PENDING',
      reason: 'STANDARD_BUSY',
      chain: [...chain.path].reverse(),
      combinedUncertainty: chain.combinedUncertainty,
      budget,
      margin,
      leased: chain.path.slice(1).filter((id) => state.leases[id]),
    };
  }

  const chain = best(chains);
  return finishRefute([
    {
      type: 'BUDGET_EXCEEDED',
      chain: [...chain.path].reverse(),
      combinedUncertainty: chain.combinedUncertainty,
      budget,
    },
  ]);
}

module.exports = {
  DEFAULT_MARGIN,
  evaluate,
  explore,
  minimizeCore,
  labFromCore,
  latestMeasurement,
  inWindow,
  combineUncertainty,
};
