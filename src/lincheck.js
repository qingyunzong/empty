import { HbGraph } from './hb.js';
import { expectedStateOk } from './merge.js';
import { err } from './errors.js';

// Linearizability check for a real-time log over committed batches.
//
// Log: JSON array (or JSONL) of { batch, start, end } with numeric ticks.
// Must-precede edges = happens-before edges (deps + process order) restricted
// to logged batches, plus real-time edges (end_i <= start_j => i before j).
// The history is linearizable iff the combined graph is acyclic; a topological
// order is a witness serial execution. Additionally every version certificate
// in the repo is re-verified against serial replay of its parents + batches.
export function lincheck(repo, entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw err('E_INVALID', 'log must be a non-empty array of {batch,start,end}');
  const seen = new Map();
  for (const e of entries) {
    const id = e.batch ?? e.id;
    if (typeof id !== 'string') throw err('E_INVALID', 'log entry needs a batch id');
    if (!repo.hasBatch(id)) throw err('E_ORPHAN', `log refers to unknown batch ${id}`, { batch: id });
    if (typeof e.start !== 'number' || typeof e.end !== 'number')
      throw err('E_INVALID', `log entry for ${id} needs numeric start/end`);
    seen.set(id, e);
  }
  const ids = [...seen.keys()];
  const batches = ids.map((id) => repo.getBatch(id));

  const edges = new Map(ids.map((id) => [id, new Set()]));
  const hb = new HbGraph(batches);
  for (const [from, to] of hb.edges()) edges.get(from)?.add(to);
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b && seen.get(a).end <= seen.get(b).start) edges.get(a).add(b);
    }
  }

  const order = topoSort(ids, edges);
  if (order === null) {
    const cycle = findCycle(ids, edges);
    throw err('E_NONLINEAR', `no serial order respects happens-before + real-time (cycle: ${cycle.join(' -> ')})`, { cycle });
  }

  // Certificate verification: each recorded view version must equal the
  // serial replay of its parents' states plus its applied batches.
  const bad = [];
  for (const view of repo.listViews()) {
    for (const v of repo.listVersions(view)) {
      const r = expectedStateOk(repo, view, v);
      if (!r.ok) bad.push({ view, version: v.id, reason: r.reason });
    }
  }
  if (bad.length > 0) {
    throw err('E_NONLINEAR', `${bad.length} version certificate(s) not explained by serial replay`, { bad });
  }

  return { ok: true, order };
}

function topoSort(ids, edges) {
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const tos of edges.values()) for (const t of tos) indeg.set(t, indeg.get(t) + 1);
  const queue = ids.filter((id) => indeg.get(id) === 0).sort();
  const order = [];
  while (queue.length) {
    const x = queue.shift();
    order.push(x);
    for (const t of [...edges.get(x)].sort()) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  return order.length === ids.length ? order : null;
}

function findCycle(ids, edges) {
  const color = new Map(ids.map((id) => [id, 0]));
  const stack = [];
  const dfs = (x) => {
    color.set(x, 1);
    stack.push(x);
    for (const t of edges.get(x)) {
      if (color.get(t) === 1) return stack.slice(stack.indexOf(t)).concat(t);
      if (color.get(t) === 0) {
        const r = dfs(t);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(x, 2);
    return null;
  };
  for (const id of ids) {
    if (color.get(id) === 0) {
      const r = dfs(id);
      if (r) return r;
    }
  }
  return ids;
}
