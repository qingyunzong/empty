import { test } from "node:test";
import * as assert from "node:assert";
import { buildGraph, Graph } from "../src/graph.js";
import {
  applyBatch,
  computeOrder,
  ConflictChain,
  DepAddition,
  fromSnapshot,
  initialState,
  publish,
  revise,
  RevisionBatch,
  State,
  toSnapshot,
} from "../src/state.js";
import { LogEvent } from "../src/types.js";
import { mulberry32, pick, randomDag } from "./util.js";

const ev = (id: string, ts: number, deps: string[] = [], source = "s", seq = 0): LogEvent => ({
  id,
  source,
  seq,
  ts,
  deps,
});

test("accepted revision reorders only the unpublished region", () => {
  let state = initialState([ev("a", 10), ev("b", 20)]);
  state = publish(state, 1);
  assert.deepStrictEqual(state.published, ["a"]);
  const res = revise(state, { events: [ev("c", 5, [], "s", 2)], addDeps: [] });
  assert.ok(res.ok);
  // c has the smallest timestamp but the published prefix stays fixed.
  assert.deepStrictEqual(res.order.order, ["a", "c", "b"]);
});

test("new dependency requiring an unpublished event first -> whole batch rejected", () => {
  let state = initialState([ev("a", 1), ev("b", 2), ev("c", 3)]);
  state = publish(state, 2); // publishes [a, b]
  const before = computeOrder(state).order;
  const res = revise(state, { events: [], addDeps: [{ id: "a", dep: "c" }] });
  assert.ok(!res.ok);
  assert.strictEqual(res.conflicts[0].reason, "prefix-inversion");
  assert.deepStrictEqual(res.conflicts[0].chain, ["c", "a"]);
  assert.strictEqual(res.conflicts[0].published, "a");
  assert.strictEqual(res.conflicts[0].publishedIndex, 0);
  assert.strictEqual(res.conflicts[0].offendingPublishedIndex, null);
  assert.deepStrictEqual(res.conflicts[0].newEdges, [{ id: "a", dep: "c" }]);
  // Atomic rejection: the state is untouched.
  assert.deepStrictEqual(computeOrder(state).order, before);
});

test("new dependency inverting two published events -> rejected with chain", () => {
  let state = initialState([ev("a", 1), ev("b", 2)]);
  state = publish(state, 2); // [a, b]
  const res = revise(state, { events: [], addDeps: [{ id: "a", dep: "b" }] });
  assert.ok(!res.ok);
  assert.deepStrictEqual(res.conflicts[0].chain, ["b", "a"]);
  assert.strictEqual(res.conflicts[0].offendingPublishedIndex, 1);
});

test("dependency cycle through a published event -> rejected", () => {
  let state = initialState([ev("a", 1), ev("x", 2, ["a"])]);
  state = publish(state, 1); // [a]
  const res = revise(state, { events: [], addDeps: [{ id: "a", dep: "x" }] });
  assert.ok(!res.ok);
  assert.deepStrictEqual(res.conflicts[0].chain, ["x", "a"]);
});

test("missing dependency attached to a published event -> rejected", () => {
  let state = initialState([ev("a", 1), ev("b", 2)]);
  state = publish(state, 1); // [a]
  const res = revise(state, { events: [], addDeps: [{ id: "a", dep: "ghost" }] });
  assert.ok(!res.ok);
  assert.strictEqual(res.conflicts[0].reason, "missing-dep");
  assert.deepStrictEqual(res.conflicts[0].chain, ["ghost", "a"]);
});

test("shortest conflict chain is reported first", () => {
  // m1 <- m2 (m2 depends on m1); p1 published. Batch: p1 depends on m2.
  // Ancestors of p1: m2 (distance 1) and m1 (distance 2) -> shortest is [m2, p1].
  let state = initialState([ev("p1", 1), ev("m1", 2), ev("m2", 3, ["m1"])]);
  state = publish(state, 1); // [p1]
  const res = revise(state, { events: [], addDeps: [{ id: "p1", dep: "m2" }] });
  assert.ok(!res.ok);
  assert.deepStrictEqual(res.conflicts[0].chain, ["m2", "p1"]);
  assert.ok(res.conflicts.every((c) => c.chain.length >= 2));
});

test("redeclared event with different fields is an error, not a conflict", () => {
  const state = initialState([ev("a", 1)]);
  assert.throws(() =>
    revise(state, { events: [ev("a", 999)], addDeps: [] })
  );
});

// ---------------------------------------------------------------------------
// Property test: random revisions, incremental state vs full-graph rebuild.
// ---------------------------------------------------------------------------

/** Independent check: does any published event have an invalid ancestor? */
function hasPrefixViolation(g: Graph, published: string[]): boolean {
  const idx = new Map(published.map((p, i) => [p, i]));
  for (const p of published) {
    if ((g.directMissing.get(p) ?? []).length > 0) return true;
    const seen = new Set<string>();
    const stack = [...(g.presentDeps.get(p) ?? [])];
    while (stack.length > 0) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      if (u === p) return true; // cycle back through p
      const i = idx.get(u);
      if (i === undefined || i >= idx.get(p)!) return true;
      stack.push(...(g.presentDeps.get(u) ?? []));
    }
  }
  return false;
}

/** Independent BFS for the shortest conflict-chain length (in edges). */
function shortestConflictDistance(g: Graph, published: string[]): number {
  const idx = new Map(published.map((p, i) => [p, i]));
  let best = Infinity;
  for (const p of published) {
    if ((g.directMissing.get(p) ?? []).length > 0) best = Math.min(best, 1);
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const d of g.presentDeps.get(p) ?? []) {
      if (!dist.has(d)) {
        dist.set(d, 1);
        queue.push(d);
      }
    }
    for (let h = 0; h < queue.length; h++) {
      const u = queue[h];
      const du = dist.get(u)!;
      if (du >= best) continue;
      const i = idx.get(u);
      if (i === undefined || i >= idx.get(p)!) {
        best = du;
        continue;
      }
      for (const v of g.presentDeps.get(u) ?? []) {
        if (!dist.has(v)) {
          dist.set(v, du + 1);
          queue.push(v);
        }
      }
    }
  }
  return best;
}

function verifyChains(conflicts: ConflictChain[], g: Graph, published: string[]): void {
  assert.ok(conflicts.length > 0);
  const idx = new Map(published.map((p, i) => [p, i]));
  for (let i = 1; i < conflicts.length; i++) {
    assert.ok(conflicts[i].chain.length >= conflicts[i - 1].chain.length);
  }
  for (const c of conflicts) {
    const chain = c.chain;
    const last = chain[chain.length - 1];
    assert.strictEqual(last, c.published);
    assert.strictEqual(idx.get(last), c.publishedIndex);
    if (c.reason === "missing-dep") {
      assert.deepStrictEqual(chain, [c.requiredFirst, c.published]);
      assert.ok(!g.events.has(chain[0]));
      assert.ok(g.events.get(last)!.deps.includes(chain[0]));
    } else {
      for (let i = 0; i + 1 < chain.length; i++) {
        assert.ok(
          g.presentDeps.get(chain[i + 1])!.includes(chain[i]),
          `${chain[i + 1]} must depend on ${chain[i]}`
        );
      }
      const fi = idx.get(chain[0]);
      assert.ok(fi === undefined || fi >= c.publishedIndex);
    }
  }
  // Minimality: the first (shortest) chain matches an independent BFS.
  assert.strictEqual(conflicts[0].chain.length - 1, shortestConflictDistance(g, published));
}

function randomBatch(
  rnd: () => number,
  full: Map<string, LogEvent>,
  published: string[],
  tag: number
): RevisionBatch {
  const events: LogEvent[] = [];
  const addDeps: DepAddition[] = [];
  const ids = [...full.keys()];
  if (rnd() < 0.45 && ids.length > 0) {
    const count = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < count; i++) {
      const usePublished = published.length > 0 && rnd() < 0.4;
      const id = usePublished ? pick(rnd, published) : pick(rnd, ids);
      const r = rnd();
      const dep = r < 0.15 ? `missing${Math.floor(rnd() * 3)}` : pick(rnd, ids);
      addDeps.push({ id, dep });
    }
  } else {
    const count = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      const id = `x${tag}_${i}`;
      if (full.has(id)) continue;
      const deps: string[] = [];
      for (const d of ids) if (rnd() < 0.25) deps.push(d);
      if (rnd() < 0.15) deps.push(`missing${Math.floor(rnd() * 3)}`);
      events.push({
        id,
        source: "ext",
        seq: tag + i,
        ts: Math.floor(rnd() * 20),
        deps: [...new Set(deps)],
      });
    }
  }
  return { events, addDeps };
}

test("random revisions: incremental matches full rebuild; rejections are sound and atomic", () => {
  const rnd = mulberry32(987654321);
  let accepted = 0;
  let rejected = 0;
  for (let trial = 0; trial < 120; trial++) {
    const n = 3 + Math.floor(rnd() * 9);
    const base = randomDag(rnd, n, 0.35);
    let state = initialState(base);
    state = publish(state, Math.floor(rnd() * (n + 1)));
    const published = [...state.published];
    let full = new Map<string, LogEvent>(base.map((e) => [e.id, { ...e, deps: [...e.deps] }]));
    const batches = 1 + Math.floor(rnd() * 3);
    for (let bi = 0; bi < batches; bi++) {
      const batch = randomBatch(rnd, full, published, trial * 10 + bi);
      const res = revise(state, batch);
      const candidate = applyBatch(full, batch).events;
      const g = buildGraph(candidate.values());
      if (res.ok) {
        accepted++;
        assert.ok(!hasPrefixViolation(g, published), `trial ${trial}: accepted batch violates prefix`);
        state = res.state;
        full = candidate;
        // Cross-check against a full-graph rebuild from raw inputs.
        const rebuilt: State = {
          events: new Map([...full].map(([id, e]) => [id, { ...e, deps: [...e.deps] }])),
          published,
        };
        assert.deepStrictEqual(computeOrder(state).order, computeOrder(rebuilt).order);
        // Cross-check against a snapshot round-trip.
        const restored = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(state))));
        assert.deepStrictEqual(computeOrder(restored).order, computeOrder(state).order);
      } else {
        rejected++;
        assert.ok(hasPrefixViolation(g, published), `trial ${trial}: rejected batch has no violation`);
        verifyChains(res.conflicts, g, published);
        // Atomic: the surviving state equals the pre-batch rebuild.
        assert.deepStrictEqual(
          computeOrder(state).order,
          computeOrder({ events: full, published }).order
        );
      }
    }
  }
  assert.ok(accepted > 50, `expected enough accepted batches, got ${accepted}`);
  assert.ok(rejected > 20, `expected enough rejected batches, got ${rejected}`);
});
