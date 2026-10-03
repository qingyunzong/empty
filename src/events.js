import { ExitError, EXIT } from './errors.js';

export function normalizeEvents(grants, tasks) {
  const events = [];
  for (const g of grants) {
    events.push({ id: g.event, lamport: g.lamport, parents: g.parents ?? [], owner: `${g.op}:${g.id}` });
  }
  for (const t of tasks) {
    const d = t.dispatch ?? {};
    events.push({ id: d.event, lamport: d.lamport, parents: d.parents ?? [], owner: `task:${t.id}` });
  }
  return events;
}

export function buildEventIndex(events) {
  const index = new Map();
  for (const e of events) {
    if (typeof e.id !== 'string' || typeof e.lamport !== 'number') {
      throw new ExitError(EXIT.MISSING_PARENT, `event from ${e.owner} missing id/lamport clock`);
    }
    if (index.has(e.id)) {
      throw new ExitError(EXIT.MISSING_PARENT, `duplicate event id ${e.id}`);
    }
    index.set(e.id, e);
  }
  for (const e of events) {
    for (const p of e.parents) {
      const parent = index.get(p);
      if (!parent) {
        throw new ExitError(EXIT.MISSING_PARENT, `event ${e.id} references missing parent event ${p}`);
      }
      if (!(parent.lamport < e.lamport)) {
        throw new ExitError(
          EXIT.MISSING_PARENT,
          `lamport violation: event ${e.id}(${e.lamport}) not after parent ${p}(${parent.lamport})`,
        );
      }
    }
  }
  const cache = new Map();
  const ancestors = (id) => {
    if (cache.has(id)) return cache.get(id);
    const set = new Set();
    for (const p of index.get(id).parents) {
      set.add(p);
      for (const a of ancestors(p)) set.add(a);
    }
    cache.set(id, set);
    return set;
  };
  const isCausallyBefore = (a, b) =>
    a !== b && index.has(a) && index.has(b) && ancestors(b).has(a);
  const causalPath = (a, b) => {
    if (!index.has(a) || !index.has(b)) return null;
    if (a === b) return [a];
    const nextHop = new Map();
    const visited = new Set([b]);
    const queue = [b];
    while (queue.length) {
      const cur = queue.shift();
      for (const p of index.get(cur).parents) {
        if (visited.has(p)) continue;
        visited.add(p);
        nextHop.set(p, cur);
        if (p === a) {
          const path = [a];
          let node = a;
          while (node !== b) {
            node = nextHop.get(node);
            path.push(node);
          }
          return path;
        }
        queue.push(p);
      }
    }
    return null;
  };
  return { index, isCausallyBefore, causalPath };
}
