// Dependency graph utilities. Edge direction: if event E dependsOn D, then D
// must precede E in any causal order. Timestamps never constrain causality.

export function compareIdsByKey(events, a, b) {
  const ea = events.get(a);
  const eb = events.get(b);
  if (ea.ts !== eb.ts) return ea.ts - eb.ts;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function dependentsIndex(events) {
  const idx = new Map([...events.keys()].map((id) => [id, []]));
  for (const e of events.values()) {
    for (const d of e.dependsOn) {
      const list = idx.get(d);
      if (list) list.push(e.id);
    }
  }
  for (const list of idx.values()) list.sort();
  return idx;
}

export function transitiveDependents(events, ids) {
  const idx = dependentsIndex(events);
  const seen = new Set(ids);
  const stack = [...ids];
  while (stack.length) {
    for (const n of idx.get(stack.pop()) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

// Returns { nodes: [v0, v1, ..., v0], edges: [{event, dependsOn}, ...] } where
// each edge satisfies nodes[i+1] in dependsOn(nodes[i]); null when acyclic.
export function findCycle(events) {
  const color = new Map();
  const stack = [];
  const ids = [...events.keys()].sort();
  for (const start of ids) {
    if (color.has(start)) continue;
    color.set(start, 1);
    stack.push(start);
    const frames = [[start, 0]];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const u = frame[0];
      const deps = events.get(u).dependsOn;
      let advanced = false;
      while (frame[1] < deps.length) {
        const v = deps[frame[1]++];
        if (!events.has(v)) continue;
        const c = color.get(v) ?? 0;
        if (c === 0) {
          color.set(v, 1);
          stack.push(v);
          frames.push([v, 0]);
          advanced = true;
          break;
        } else if (c === 1) {
          const idx = stack.indexOf(v);
          const nodes = stack.slice(idx).concat(v);
          const edges = [];
          for (let i = 0; i + 1 < nodes.length; i++) {
            edges.push({ event: nodes[i], dependsOn: nodes[i + 1] });
          }
          return { nodes, edges };
        }
      }
      if (!advanced) {
        color.set(u, 2);
        stack.pop();
        frames.pop();
      }
    }
  }
  return null;
}

// Deterministic Kahn topological order. Each round chooses the minimal
// available event by (ts, id). The certificate records, per step, the chosen
// id and the full candidate set so an independent checker can replay it.
export function kahnCertificate(events) {
  const dependents = dependentsIndex(events);
  const indeg = new Map();
  for (const [id, e] of events) {
    indeg.set(id, e.dependsOn.filter((d) => events.has(d)).length);
  }
  let avail = [...events.keys()].filter((id) => indeg.get(id) === 0);
  const steps = [];
  const order = [];
  while (avail.length) {
    avail.sort((a, b) => compareIdsByKey(events, a, b));
    const chosen = avail[0];
    steps.push({ chosen, candidates: [...avail] });
    order.push(chosen);
    avail = avail.slice(1);
    for (const n of dependents.get(chosen) ?? []) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) avail.push(n);
    }
  }
  return {
    algorithm: 'kahn-min-ts-id',
    order,
    steps,
    complete: order.length === events.size,
  };
}

// A non-deleted event is BLOCKED when any of its dependencies is deleted.
// Dependencies are never silently removed.
export function computeBlocked(events) {
  const blocked = [];
  for (const e of events.values()) {
    if (e.deleted) continue;
    const bad = e.dependsOn.filter((d) => events.get(d)?.deleted).sort();
    if (bad.length) blocked.push({ id: e.id, blockedBy: bad });
  }
  return blocked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Exhaustive enumeration of all topological orders (test aid, n <= 7).
export function enumerateTopoOrders(events, limit = 200000) {
  const dependents = dependentsIndex(events);
  const indeg = new Map();
  for (const [id, e] of events) {
    indeg.set(id, e.dependsOn.filter((d) => events.has(d)).length);
  }
  const avail = [...events.keys()].filter((id) => indeg.get(id) === 0);
  const orders = [];
  const cur = [];
  (function bt() {
    if (orders.length >= limit) return;
    if (cur.length === events.size) {
      orders.push([...cur]);
      return;
    }
    for (let i = 0; i < avail.length; i++) {
      const id = avail[i];
      avail.splice(i, 1);
      cur.push(id);
      const deps = dependents.get(id) ?? [];
      for (const n of deps) indeg.set(n, indeg.get(n) - 1);
      const added = deps.filter((n) => indeg.get(n) === 0);
      avail.push(...added);
      bt();
      avail.length -= added.length;
      for (const n of deps) indeg.set(n, indeg.get(n) + 1);
      cur.pop();
      avail.splice(i, 0, id);
    }
  })();
  return orders;
}
