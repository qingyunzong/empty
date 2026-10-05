import { buildGraph } from "./graph.js";
import { deterministicOrder, OrderResult } from "./topo.js";
import { LogEvent, validateEvent } from "./types.js";

/**
 * Replicated log state. `published` is the fixed, already-published prefix
 * of the output order; every other known event lives in the reorderable
 * unpublished region.
 */
export interface State {
  events: Map<string, LogEvent>;
  published: string[];
}

export function initialState(events: LogEvent[] = []): State {
  return { events: new Map(events.map((e) => [e.id, e])), published: [] };
}

export function computeOrder(state: State): OrderResult {
  return deterministicOrder(buildGraph(state.events.values()), state.published);
}

export interface DepAddition {
  id: string;
  dep: string;
}

/** A revision batch: new/updated events plus dependency additions. */
export interface RevisionBatch {
  events: LogEvent[];
  addDeps: DepAddition[];
}

export interface ConflictChain {
  reason: "prefix-inversion" | "missing-dep";
  /**
   * Dependency chain [a, ..., p]: every element must be ordered before the
   * next one, so `a` must precede the published event `p` -- but the fixed
   * prefix already places `p` first. For "missing-dep", chain is [missing, p].
   */
  chain: string[];
  /** The event (or missing id) the new dependencies require to come first. */
  requiredFirst: string;
  /** The published event at the end of the chain. */
  published: string;
  publishedIndex: number;
  /** Published index of `requiredFirst`, or null if it is not published. */
  offendingPublishedIndex: number | null;
  /** Edges introduced by this batch that lie on the chain. */
  newEdges: DepAddition[];
}

export type ReviseResult =
  | { ok: true; state: State; order: OrderResult }
  | { ok: false; conflicts: ConflictChain[] };

/**
 * Merge a batch into an event map (pure: returns a new map). New events are
 * added; re-declared events must keep the same source/seq/ts and get their
 * dependency sets merged. Returns the introduced dependency edges.
 */
export function applyBatch(
  events: Map<string, LogEvent>,
  batch: RevisionBatch
): { events: Map<string, LogEvent>; introduced: DepAddition[] } {
  const next = new Map(events);
  const introduced: DepAddition[] = [];
  const addEdge = (id: string, dep: string): void => {
    const e = next.get(id)!;
    if (!e.deps.includes(dep)) {
      next.set(id, { ...e, deps: [...e.deps, dep].sort() });
      introduced.push({ id, dep });
    }
  };
  for (const raw of batch.events) {
    const e = validateEvent(raw, "revision batch");
    const existing = next.get(e.id);
    if (!existing) {
      next.set(e.id, e);
      for (const d of e.deps) introduced.push({ id: e.id, dep: d });
    } else {
      if (existing.source !== e.source || existing.seq !== e.seq || existing.ts !== e.ts) {
        throw new Error(`event ${e.id} redeclared with different source/seq/ts`);
      }
      for (const d of e.deps) addEdge(e.id, d);
    }
  }
  for (const { id, dep } of batch.addDeps) {
    if (!next.has(id)) throw new Error(`addDep references unknown event: ${id}`);
    addEdge(id, dep);
  }
  return { events: next, introduced };
}

/**
 * Incremental causal revision.
 *
 * The published prefix is fixed: after applying the batch, every (transitive)
 * dependency of a published event must still be published earlier. If any new
 * dependency would require inverting the published prefix (or attaches a
 * missing dependency to a published event), the WHOLE batch is rejected
 * atomically and the shortest conflict chain(s) are returned as evidence.
 * Otherwise the batch is applied and the unpublished region is reordered.
 */
export function revise(state: State, batch: RevisionBatch): ReviseResult {
  const { events, introduced } = applyBatch(state.events, batch);
  const introducedKeys = new Set(introduced.map((x) => `${x.id}|${x.dep}`));
  const g = buildGraph(events.values());
  const pubIndex = new Map<string, number>();
  state.published.forEach((id, i) => pubIndex.set(id, i));

  const conflicts: ConflictChain[] = [];
  const seenChains = new Set<string>();
  const pushConflict = (c: ConflictChain): void => {
    const key = `${c.reason}:${c.chain.join("")}`;
    if (seenChains.has(key)) return;
    seenChains.add(key);
    conflicts.push(c);
  };

  // (1) Missing dependencies attached directly to a published event.
  for (const p of state.published) {
    for (const m of g.directMissing.get(p) ?? []) {
      pushConflict({
        reason: "missing-dep",
        chain: [m, p],
        requiredFirst: m,
        published: p,
        publishedIndex: pubIndex.get(p)!,
        offendingPublishedIndex: null,
        newEdges: introducedKeys.has(`${p}|${m}`) ? [{ id: p, dep: m }] : [],
      });
    }
  }

  // (2) Prefix inversions: a published event gains an ancestor that is
  // unpublished or published later. BFS from each published event over
  // "depends on" edges yields the shortest such chain(s).
  for (const p of state.published) {
    const pi = pubIndex.get(p)!;
    const dist = new Map<string, number>();
    const parent = new Map<string, string>();
    const queue: string[] = [];
    for (const v of g.presentDeps.get(p) ?? []) {
      if (!dist.has(v)) {
        dist.set(v, 1);
        parent.set(v, p);
        queue.push(v);
      }
    }
    let foundAt = Infinity;
    const found: string[] = [];
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head];
      const du = dist.get(u)!;
      if (du > foundAt) break;
      const uIdx = pubIndex.get(u);
      // Note: u === p is invalid too (dependency cycle back through p).
      if (uIdx === undefined || uIdx >= pi) {
        foundAt = du;
        found.push(u);
        continue; // chains end at the first offending ancestor
      }
      for (const v of g.presentDeps.get(u) ?? []) {
        if (!dist.has(v)) {
          dist.set(v, du + 1);
          parent.set(v, u);
          queue.push(v);
        }
      }
    }
    for (const v of found) {
      const chain = [v];
      let cur = v;
      do {
        cur = parent.get(cur)!;
        chain.push(cur);
      } while (cur !== p);
      const newEdges: DepAddition[] = [];
      for (let i = 0; i + 1 < chain.length; i++) {
        const dep = chain[i];
        const id = chain[i + 1];
        if (introducedKeys.has(`${id}|${dep}`)) newEdges.push({ id, dep });
      }
      pushConflict({
        reason: "prefix-inversion",
        chain,
        requiredFirst: v,
        published: p,
        publishedIndex: pi,
        offendingPublishedIndex: pubIndex.get(v) ?? null,
        newEdges,
      });
    }
  }

  if (conflicts.length > 0) {
    conflicts.sort(
      (a, b) => a.chain.length - b.chain.length || a.chain.join("").localeCompare(b.chain.join(""))
    );
    return { ok: false, conflicts: conflicts.slice(0, 20) };
  }
  const next: State = { events, published: state.published };
  return { ok: true, state: next, order: computeOrder(next) };
}

/**
 * Publish the next `n` events of the computed order, extending the fixed
 * prefix. Withheld (missing-dep) and cyclic events are never emittable, so
 * they can never be published.
 */
export function publish(state: State, n: number): State {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid publish count: ${n}`);
  const res = computeOrder(state);
  const tail = res.order.slice(state.published.length);
  if (n > tail.length) {
    throw new Error(`cannot publish ${n} event(s): only ${tail.length} emittable unpublished`);
  }
  return { events: state.events, published: [...state.published, ...tail.slice(0, n)] };
}

/**
 * Serializable snapshot. Besides the raw events and the published prefix it
 * stores the derived ready-candidate set and the missing-dependency index,
 * so a restored snapshot can be validated against a recomputation.
 */
export interface Snapshot {
  version: 1;
  events: LogEvent[];
  published: string[];
  candidates: string[];
  missingIndex: Record<string, string[]>;
}

export function toSnapshot(state: State): Snapshot {
  const g = buildGraph(state.events.values());
  const res = deterministicOrder(g, state.published);
  const missingIndex: Record<string, string[]> = {};
  for (const m of [...g.missingIndex.keys()].sort()) {
    missingIndex[m] = [...g.missingIndex.get(m)!];
  }
  return {
    version: 1,
    events: [...state.events.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    published: [...state.published],
    candidates: res.candidates,
    missingIndex,
  };
}

/** Restore a state from a snapshot, validating the derived data it carries. */
export function fromSnapshot(raw: unknown): State {
  if (typeof raw !== "object" || raw === null) throw new Error("snapshot must be an object");
  const s = raw as Record<string, unknown>;
  if (s.version !== 1) throw new Error("unsupported snapshot version");
  if (!Array.isArray(s.events)) throw new Error("snapshot.events must be an array");
  const events = s.events.map((e, i) => validateEvent(e, `snapshot.events[${i}]`));
  if (!Array.isArray(s.published) || s.published.some((x) => typeof x !== "string")) {
    throw new Error("snapshot.published must be an array of strings");
  }
  if (!Array.isArray(s.candidates) || s.candidates.some((x) => typeof x !== "string")) {
    throw new Error("snapshot.candidates must be an array of strings");
  }
  if (typeof s.missingIndex !== "object" || s.missingIndex === null || Array.isArray(s.missingIndex)) {
    throw new Error("snapshot.missingIndex must be an object");
  }
  for (const [k, v] of Object.entries(s.missingIndex as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new Error(`snapshot.missingIndex[${k}] must be an array of strings`);
    }
  }
  const published = s.published as string[];
  const ids = new Set(events.map((e) => e.id));
  if (ids.size !== events.length) throw new Error("duplicate event id in snapshot");
  if (new Set(published).size !== published.length) {
    throw new Error("duplicate id in snapshot.published");
  }
  for (const p of published) {
    if (!ids.has(p)) throw new Error(`published event not in snapshot: ${p}`);
  }
  const state: State = {
    events: new Map(events.map((e) => [e.id, e])),
    published: [...published],
  };
  // Recompute derived data (also validates that the prefix is causally
  // consistent) and compare against what the snapshot claims.
  const recomputed = toSnapshot(state);
  if (JSON.stringify(s.candidates) !== JSON.stringify(recomputed.candidates)) {
    throw new Error("snapshot candidates do not match recomputed state");
  }
  if (JSON.stringify(s.missingIndex) !== JSON.stringify(recomputed.missingIndex)) {
    throw new Error("snapshot missing-dependency index does not match recomputed state");
  }
  return state;
}
