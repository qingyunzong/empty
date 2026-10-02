// Exact solver: assign each carrier to at most one tool window.
// Hard constraint: sum of qty per tool window <= cap (never negative remaining).
// Objective: maximize sum(score(lot) * qty) over assigned carriers.
// All tied optima are enumerated (up to maxTies stored); the canonical plan is
// the lexicographically smallest under the (due, lot, carrier) tie-break order.

function cmpCarrier(a, b) {
  if (a.due !== b.due) return a.due - b.due;
  if (a.lot !== b.lot) return a.lot < b.lot ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function solve(carriers, tools, scoreByLot, options = {}) {
  const maxTies = options.maxTies ?? 1000;
  const maxNodes = options.maxNodes ?? 5_000_000;
  const toolList = tools.map((t) => ({ ...t }));
  const items = carriers.map((c) => {
    const score = scoreByLot.get(c.lot) ?? 0;
    return {
      id: c.id,
      lot: c.lot,
      qty: c.qty,
      due: c.due,
      ts: c.ts,
      score,
      value: score * c.qty,
      feasible: toolList
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => c.ts >= t.windowStart && c.ts <= t.windowEnd && t.cap >= c.qty)
        .map(({ i }) => i),
    };
  });

  // Branch order: highest value first (pruning), deterministic tie-breaks.
  const order = items.map((_, i) => i);
  order.sort((a, b) => {
    const va = items[a].value;
    const vb = items[b].value;
    if (vb !== va) return vb - va;
    return cmpCarrier(items[a], items[b]);
  });

  const n = items.length;
  const remaining = toolList.map((t) => t.cap);
  // Upper bound: current value + sum of positive values of unvisited carriers.
  const suffix = new Array(n + 1).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    const v = items[order[k]].value;
    suffix[k] = suffix[k + 1] + (v > 0 ? v : 0);
  }

  let best = 0; // the all-unassigned plan is always feasible with value 0
  let tieCount = 0;
  let truncated = false;
  let nodes = 0;
  const assign = new Array(n).fill(-1); // tool index per item index
  const solutions = [];

  function dfs(k, value) {
    if (truncated && nodes > maxNodes) return;
    nodes++;
    if (value + suffix[k] < best) return;
    if (k === n) {
      if (value > best) {
        best = value;
        tieCount = 1;
        solutions.length = 0;
        solutions.push(assign.slice());
        truncated = false;
      } else if (value === best) {
        tieCount++;
        if (solutions.length < maxTies) solutions.push(assign.slice());
        else truncated = true;
      }
      return;
    }
    const item = items[order[k]];
    for (const ti of item.feasible) {
      if (remaining[ti] >= item.qty) {
        remaining[ti] -= item.qty;
        assign[order[k]] = ti;
        dfs(k + 1, value + item.value);
        remaining[ti] += item.qty;
      }
    }
    assign[order[k]] = -1;
    dfs(k + 1, value);
  }
  dfs(0, 0);
  if (nodes > maxNodes) truncated = true;

  // Deterministic output: assignments sorted by (due, lot, carrier); solutions
  // sorted lexicographically by their serialization.
  const itemOrder = items.map((_, i) => i).sort((a, b) => cmpCarrier(items[a], items[b]));
  const decorated = solutions.map((sol) => {
    const assignments = [];
    const toolSeq = [];
    for (const i of itemOrder) {
      const toolId = sol[i] >= 0 ? toolList[sol[i]].id : null;
      toolSeq.push(toolId);
      if (toolId !== null) {
        assignments.push({
          carrier: items[i].id,
          tool: toolId,
          lot: items[i].lot,
          qty: items[i].qty,
          score: items[i].score,
          due: items[i].due,
        });
      }
    }
    let assignedQty = 0;
    for (let k = 0; k < toolSeq.length; k++) {
      if (toolSeq[k] !== null) assignedQty += items[itemOrder[k]].qty;
    }
    return { toolSeq, assignedQty, assignments };
  });
  // Canonical order: first free as much budget as possible (min assigned qty,
  // so a retracted metro releases its locked budget), then in (due, lot,
  // carrier) sequence an assigned carrier ranks before an unassigned one;
  // among assigned, smaller tool id first.
  decorated.sort((a, b) => {
    if (a.assignedQty !== b.assignedQty) return a.assignedQty - b.assignedQty;
    for (let k = 0; k < a.toolSeq.length; k++) {
      const ta = a.toolSeq[k];
      const tb = b.toolSeq[k];
      if (ta === tb) continue;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta < tb ? -1 : 1;
    }
    return 0;
  });

  const canonicalMap = new Map();
  for (const c of items) canonicalMap.set(c.id, null);
  if (decorated.length > 0) {
    for (const a of decorated[0].assignments) canonicalMap.set(a.carrier, a.tool);
  }

  return {
    objective: best,
    tieCount,
    tiesTruncated: truncated,
    solutions: decorated.map((d) => ({ objective: best, assignments: d.assignments })),
    canonical: decorated.length > 0 ? decorated[0].assignments : [],
    canonicalMap,
  };
}
