// Derived data over a merged event set: dependency edges with branch
// provenance, cycle detection, deterministic Kahn topology certificate and
// BLOCKED reports (full and incremental).

import { compareIds } from './util.js';

const byTsId = (events) => (a, b) => events[a].ts - events[b].ts || compareIds(a, b);

function edgeProvenance(eventId, target, branches, dependsOnOrigin) {
  const presentIn = ['base', 'local', 'remote']
    .filter((n) => branches[n] && branches[n][eventId] && branches[n][eventId].dependsOn.includes(target));
  let addedBy;
  if (dependsOnOrigin.has(eventId)) {
    addedBy = [dependsOnOrigin.get(eventId), 'resolution'];
  } else if (presentIn.includes('base')) {
    addedBy = ['base'];
  } else {
    addedBy = presentIn.filter((n) => n !== 'base');
  }
  return { presentIn, addedBy };
}

export function computeDerived(events, branches = {}, dependsOnOrigin = new Map()) {
  const errors = [];
  const edges = [];
  const adj = new Map(Object.keys(events).map((id) => [id, []]));

  for (const [id, e] of Object.entries(events)) {
    for (const t of e.dependsOn) {
      if (!events[t]) {
        errors.push({ type: 'MISSING_REF', event: id, target: t });
        continue;
      }
      const prov = edgeProvenance(id, t, branches, dependsOnOrigin);
      edges.push({ from: t, to: id, ...prov });
      adj.get(t).push(id);
    }
  }
  edges.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));

  const cycle = errors.length === 0 ? findCycle(Object.keys(events).sort(), adj, edges) : null;

  let order = null;
  let rounds = null;
  if (!cycle && errors.length === 0) {
    ({ order, rounds } = kahn(events));
  }

  return { edges, errors, cycle, order, rounds, blocked: computeBlocked(events) };
}

// DFS-based cycle search. Returns a verifiable cycle: ordered vertex list
// (last edge closes back to the first vertex) plus the edges with provenance.
export function findCycle(ids, adj, edges) {
  const color = new Map(ids.map((id) => [id, 0]));
  const stack = [];
  let found = null;

  const dfs = (u) => {
    if (found) return;
    color.set(u, 1);
    stack.push(u);
    for (const v of [...adj.get(u)].sort()) {
      if (found) return;
      if (color.get(v) === 0) {
        dfs(v);
      } else if (color.get(v) === 1) {
        const start = stack.indexOf(v);
        found = stack.slice(start).concat([v]);
        return;
      }
    }
    stack.pop();
    color.set(u, 2);
  };

  for (const id of ids) {
    if (color.get(id) === 0) dfs(id);
    if (found) break;
  }
  if (!found) return null;

  const cycleEdges = [];
  for (let i = 0; i < found.length - 1; i += 1) {
    const from = found[i];
    const to = found[i + 1];
    const edge = edges.find((e) => e.from === from && e.to === to);
    cycleEdges.push({ from, to, addedBy: edge ? edge.addedBy : [], presentIn: edge ? edge.presentIn : [] });
  }
  return { type: 'CYCLE', events: found, edges: cycleEdges };
}

// Deterministic Kahn: every round picks the (ts, id)-minimum among events
// whose dependencies are all placed. Timestamps are NOT required to increase
// along causal edges; they only break ties between ready candidates.
export function kahn(events) {
  const placed = new Set();
  const remaining = new Set(Object.keys(events));
  const order = [];
  const rounds = [];
  const cmp = byTsId(events);
  while (remaining.size > 0) {
    const candidates = [...remaining]
      .filter((id) => events[id].dependsOn.every((t) => !events[t] || placed.has(t)))
      .sort(cmp);
    if (candidates.length === 0) break; // cycle guard; caller checks first
    const chosen = candidates[0];
    rounds.push({ chosen, candidates });
    order.push(chosen);
    placed.add(chosen);
    remaining.delete(chosen);
  }
  return { order, rounds };
}

// BLOCKED: a non-retracted event directly depends on a retracted event.
// Dependencies are never silently dropped; they are reported instead.
export function computeBlocked(events) {
  const out = [];
  for (const [id, e] of Object.entries(events)) {
    if (e.deleted) continue;
    const blockedBy = e.dependsOn.filter((t) => events[t] && events[t].deleted).sort();
    if (blockedBy.length > 0) out.push({ event: id, blockedBy });
  }
  return out.sort((a, b) => compareIds(a.event, b.event));
}

// Incremental blocked update: only the changed events and their direct
// dependents can change blocked status.
export function computeBlockedIncremental(events, prevBlocked, changedIds) {
  const region = new Set(changedIds);
  for (const [id, e] of Object.entries(events)) {
    for (const t of e.dependsOn) if (changedIds.has(t)) region.add(id);
  }
  const map = new Map(prevBlocked.map((b) => [b.event, b]));
  for (const id of region) {
    const e = events[id];
    const blockedBy = e && !e.deleted ? e.dependsOn.filter((t) => events[t] && events[t].deleted).sort() : [];
    if (blockedBy.length > 0) map.set(id, { event: id, blockedBy });
    else map.delete(id);
  }
  return [...map.values()].sort((a, b) => compareIds(a.event, b.event));
}
