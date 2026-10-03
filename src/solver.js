// Finite-domain CSP solver for quality traceability.
//
// Variables: for each production batch P (in topological order) and each
// candidate parent c, an integer quantity x[P][c] in [0, ub]. A positive
// value creates a genealogy edge c -> P.
//
// Constraints:
//   C1 input-sum:        sum_c x[P][c] = outputQty(P) + loss(P)
//   C2 no-quarantine:    no used parent may be quarantined, directly or
//                        indirectly (taint propagates along used edges)
//   C3 expiry-order:     x[P][c] > 0  =>  expiry(P) <= expiry(c)
//   C4 line-non-overlap: batches on the same line must not overlap in time
//   C5 availability:     total consumption of a batch <= its available quantity
//
// Propagation: static pruning of domains by C3, quarantine-taint closure by
// C2 (multi-layer), and quantity upper bounds by C1/C5. Backtracking search
// enumerates integer compositions of the required input over clean domains.

export function solve(model, opts = {}) {
  const budget = opts.budget ?? model.budget;
  const cap = opts.solutionCap ?? 1;
  let remaining = budget;
  const { batches, order } = model;

  const avail = (id) => {
    const b = batches.get(id);
    return b.kind === 'material' ? b.quantity : b.outputQty;
  };
  const needOf = (p) => p.outputQty + p.loss;

  // ---- C4: static line-overlap check -------------------------------------
  const byLine = new Map();
  for (const pid of order) {
    const p = batches.get(pid);
    if (!byLine.has(p.line)) byLine.set(p.line, []);
    byLine.get(p.line).push(p);
  }
  const overlaps = [];
  for (const [line, list] of byLine) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.start <= b.end && b.start <= a.end) {
          overlaps.push({ line, batches: [a.id, b.id], constraint: 'line-non-overlap' });
        }
      }
    }
  }

  // ---- Finite domains + propagation --------------------------------------
  // domains[pid][cid] = { lb, ub, expiryOk, status }
  const domains = {};
  // taint: id -> shortest known chain of batch ids from a quarantined source
  const taint = new Map();
  for (const [id, b] of batches) {
    if (b.status === 'quarantined') taint.set(id, [id]);
  }

  for (const pid of order) {
    const p = batches.get(pid);
    const need = needOf(p);
    const d = {};
    for (const c of p.candidates) {
      const expiryOk = p.expiry <= batches.get(c).expiry; // C3
      d[c] = {
        lb: 0,
        ub: Math.min(avail(c), need), // C1/C5 bound
        expiryOk,
        status: !expiryOk ? 'expiry-blocked' : taint.has(c) ? 'taint-blocked' : 'ok',
      };
    }
    domains[pid] = d;
  }

  // C2 closure: a production batch is inevitably tainted when even using
  // every clean candidate at full availability cannot meet its need, and at
  // least one tainted candidate would have to be used. Single pass suffices
  // because `order` is topological.
  for (const pid of order) {
    if (taint.has(pid)) continue;
    const p = batches.get(pid);
    const need = needOf(p);
    let cleanCap = 0;
    const via = [];
    for (const c of p.candidates) {
      const d = domains[pid][c];
      if (!d.expiryOk) continue;
      if (taint.has(c)) {
        if (d.ub > 0) via.push(c);
      } else {
        cleanCap += d.ub;
      }
    }
    if (cleanCap < need && via.length > 0) {
      let best = null;
      for (const c of via) {
        const chain = taint.get(c);
        if (!best || chain.length < best.length) best = chain;
      }
      taint.set(pid, [...best, pid]);
    }
  }
  // Refresh domain statuses with the completed taint closure.
  for (const pid of order) {
    for (const c of Object.keys(domains[pid])) {
      const d = domains[pid][c];
      if (d.expiryOk && taint.has(c)) d.status = 'taint-blocked';
    }
  }

  // ---- Backtracking search ------------------------------------------------
  const resid = new Map([...batches.keys()].map((id) => [id, avail(id)]));
  const edges = [];
  const solutions = [];
  const chosen = [];
  let conflict = null;
  let exhausted = false;
  let pending = null;

  function recordConflict(pos, pid, reasons) {
    if (!conflict || pos >= conflict.pos) conflict = { pos, batch: pid, reasons };
  }

  function analyze(pos, pid) {
    const p = batches.get(pid);
    const need = needOf(p);
    const d = domains[pid];
    const reasons = [];
    const capOf = (c) => Math.min(d[c].ub, resid.get(c));
    const expiryOkCaps = p.candidates.filter((c) => d[c].expiryOk).reduce((s, c) => s + capOf(c), 0);
    if (expiryOkCaps < need) {
      reasons.push({
        constraint: 'input-sum',
        batches: [pid, ...p.candidates],
        need,
        available: expiryOkCaps,
      });
    }
    const blockedTaint = p.candidates.filter((c) => d[c].expiryOk && taint.has(c) && d[c].ub > 0);
    if (blockedTaint.length > 0) {
      reasons.push({
        constraint: 'no-quarantine',
        batches: [pid, ...blockedTaint],
        chains: blockedTaint.map((c) => [...taint.get(c), pid]),
      });
    }
    const blockedExpiry = p.candidates.filter((c) => !d[c].expiryOk && d[c].ub > 0);
    if (blockedExpiry.length > 0 && expiryOkCaps < need) {
      reasons.push({ constraint: 'expiry-order', batches: [pid, ...blockedExpiry] });
    }
    if (reasons.length === 0) {
      reasons.push({ constraint: 'availability', batches: [pid, ...p.candidates], need });
    }
    recordConflict(pos, pid, reasons);
  }

  function makePending(pos, pid, explored) {
    pending = {
      decided: chosen.slice(0, pos).filter(Boolean),
      interruptedBatch: pid,
      exploredCombosAtInterrupt: explored,
      undecided: order.slice(pos),
    };
  }

  function search(pos) {
    if (exhausted || solutions.length >= cap) return;
    if (pos === order.length) {
      solutions.push(edges.map((e) => ({ ...e })));
      return;
    }
    const pid = order[pos];
    const p = batches.get(pid);
    const need = needOf(p);
    const d = domains[pid];
    const clean = p.candidates
      .filter((c) => d[c].expiryOk && !taint.has(c))
      .map((c) => ({ id: c, cap: Math.min(d[c].ub, resid.get(c)) }))
      .filter((c) => c.cap > 0);
    const cleanCap = clean.reduce((s, c) => s + c.cap, 0);
    if (cleanCap < need) {
      analyze(pos, pid);
      return;
    }

    const qtys = new Array(clean.length).fill(0);
    let explored = 0;

    function apply() {
      explored++;
      const inputs = {};
      const used = [];
      for (let k = 0; k < clean.length; k++) {
        if (qtys[k] > 0) {
          inputs[clean[k].id] = qtys[k];
          used.push(clean[k].id);
        }
      }
      for (const c of used) resid.set(c, resid.get(c) - inputs[c]);
      for (const c of used) edges.push({ parent: c, child: pid, quantity: inputs[c] });
      chosen[pos] = { batch: pid, inputs };
      search(pos + 1);
      chosen[pos] = undefined;
      for (let k = 0; k < used.length; k++) edges.pop();
      for (const c of used) resid.set(c, resid.get(c) + inputs[c]);
    }

    function rec(j, rest) {
      if (exhausted || solutions.length >= cap) return;
      if (j === clean.length - 1) {
        if (rest <= clean[j].cap) {
          qtys[j] = rest;
          apply();
        }
        return;
      }
      const maxQ = Math.min(clean[j].cap, rest);
      for (let q = 0; q <= maxQ; q++) {
        if (remaining <= 0) {
          exhausted = true;
          makePending(pos, pid, explored);
          return;
        }
        remaining--;
        qtys[j] = q;
        rec(j + 1, rest - q);
        if (exhausted || solutions.length >= cap) return;
      }
    }

    rec(0, need);
  }

  if (overlaps.length === 0) search(0);

  // ---- Result assembly ----------------------------------------------------
  let status;
  if (overlaps.length > 0) status = 'infeasible';
  else if (solutions.length > 0) status = 'feasible';
  else if (exhausted) status = 'unknown';
  else status = 'infeasible';

  const derived = {
    domains,
    taint: Object.fromEntries([...taint.entries()].map(([k, v]) => [k, v])),
  };

  const solution = solutions[0] ?? null;
  if (solution) {
    // Propagated effective expiry along the chosen genealogy.
    const bound = {};
    for (const [id, b] of batches) if (b.kind === 'material') bound[id] = b.expiry;
    for (const pid of order) {
      const p = batches.get(pid);
      let m = p.expiry;
      for (const e of solution) {
        if (e.child === pid && bound[e.parent] < m) m = bound[e.parent];
      }
      bound[pid] = m;
    }
    derived.expiryBound = Object.fromEntries(order.map((pid) => [pid, bound[pid]]));
  }

  let proof = null;
  if (status === 'infeasible') {
    const constraints = new Set();
    const proofBatches = new Set();
    const chainMap = new Map();
    const addChain = (chain) => chainMap.set(chain.join('>'), chain);
    for (const o of overlaps) {
      constraints.add('line-non-overlap');
      o.batches.forEach((b) => proofBatches.add(b));
    }
    if (conflict) {
      for (const r of conflict.reasons) {
        constraints.add(r.constraint);
        (r.batches ?? []).forEach((b) => proofBatches.add(b));
        (r.chains ?? []).forEach(addChain);
      }
    }
    // Extend quarantine chains through every inevitably-tainted sink batch
    // (a tainted production batch that no other batch depends on).
    const usedAsCandidate = new Set();
    for (const pid of order) for (const c of batches.get(pid).candidates) usedAsCandidate.add(c);
    for (const pid of order) {
      if (taint.has(pid) && !usedAsCandidate.has(pid)) {
        addChain(taint.get(pid));
        taint.get(pid).forEach((b) => proofBatches.add(b));
        constraints.add('no-quarantine');
      }
    }
    proof = {
      constraints: [...constraints],
      batches: [...proofBatches],
      chains: [...chainMap.values()],
      overlaps,
      conflict: conflict ? { batch: conflict.batch, reasons: conflict.reasons } : null,
    };
  }

  return {
    status,
    edges: solution ?? [],
    solutionCount: solutions.length,
    solutions: cap > 1 ? solutions : undefined,
    derived,
    proof,
    pending: status === 'unknown' ? pending : null,
    stats: { budget, budgetUsed: budget - remaining },
  };
}
