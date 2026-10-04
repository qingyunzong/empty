import test from "node:test";
import assert from "node:assert/strict";
import { LogEvent } from "../src/model.js";
import { LogStore, ReviseBatch } from "../src/store.js";
import { buildGraph, findCycles } from "../src/topo.js";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent brute-force feasibility: prefix predicate + no cycle in unpublished region. */
function bruteForceFeasible(events: LogEvent[], published: string[]): boolean {
  const byId = new Map(events.map((e) => [e.id, e]));
  const pos = new Map(published.map((id, i) => [id, i]));
  for (const e of events) {
    for (const d of e.deps) {
      if (e.id === d) return false;
      const xp = pos.get(e.id);
      if (xp === undefined) continue;
      const yp = pos.get(d);
      if (!byId.has(d) || yp === undefined || yp > xp) return false;
    }
  }
  const g = buildGraph(events);
  const pub = new Set(published);
  const unpublished = [...g.depsOf.keys()].filter((id) => !pub.has(id));
  return findCycles(unpublished, g.depsOf).length === 0;
}

test("random revisions: incremental store matches full rebuild; snapshot round-trips", () => {
  for (const seed of [1, 7, 42, 1337, 20261005]) {
    const rand = rng(seed);
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
    const sources = ["A", "B", "C"];
    const seqs = new Map(sources.map((s) => [s, 0]));

    const allEvents: LogEvent[] = [];
    const mkEvent = (n: number, depPool: string[]): LogEvent => {
      const source = pick(sources);
      const deps: string[] = [];
      for (const d of depPool) if (rand() < 0.25) deps.push(d);
      return {
        id: `e${n}`,
        source,
        seq: seqs.get(source)! + 1,
        ts: Math.floor(rand() * 100), // deliberately not causally monotonic
        deps,
      };
    };

    // Initial batch: deps only on earlier events (acyclic base).
    for (let i = 0; i < 8; i++) {
      const e = mkEvent(i, allEvents.map((x) => x.id));
      seqs.set(e.source, e.seq);
      allEvents.push(e);
    }
    let store = new LogStore(allEvents);
    let nextId = 8;

    const crossCheck = () => {
      const rebuilt = new LogStore(allEvents, store.publishedPrefix);
      assert.deepEqual(store.order, rebuilt.order, `order mismatch (seed ${seed})`);
      assert.deepEqual(store.readyFrontier(), rebuilt.readyFrontier(), `ready mismatch (seed ${seed})`);
      assert.deepEqual(store.toSnapshot().missingIndex, rebuilt.toSnapshot().missingIndex, `missing mismatch (seed ${seed})`);
    };

    for (let round = 0; round < 40; round++) {
      const op = rand();
      if (op < 0.55) {
        // revision batch: new events + random new deps (may conflict or cycle)
        const batch: ReviseBatch = { events: [], deps: [] };
        const nNew = Math.floor(rand() * 3);
        const batchEvents: LogEvent[] = [];
        for (let i = 0; i < nNew; i++) {
          const e = mkEvent(nextId++, allEvents.map((x) => x.id));
          seqs.set(e.source, e.seq);
          batchEvents.push(e);
          batch.events!.push(e);
        }
        const pool = [...allEvents.map((e) => e.id), ...batchEvents.map((e) => e.id)];
        const nDeps = Math.floor(rand() * 3);
        for (let i = 0; i < nDeps; i++) {
          batch.deps!.push({ id: pick(pool), dep: pick(pool) });
        }
        if (rand() < 0.3) {
          const maxPublish = store.unpublished.length + nNew;
          batch.publish = Math.min(Math.floor(rand() * 3), maxPublish);
        }

        const tentative = [
          ...allEvents,
          ...batchEvents,
        ].map((e) => ({ ...e, deps: [...e.deps] }));
        const byId = new Map(tentative.map((e) => [e.id, e]));
        for (const d of batch.deps!) byId.get(d.id)!.deps.push(d.dep);

        // Predicted publish count only applies when accepted.
        const publishedBefore = store.publishedPrefix;
        const result = store.revise(batch);
        const feasible = bruteForceFeasible([...byId.values()], publishedBefore);
        assert.equal(result.accepted, feasible, `accept/reject mismatch (seed ${seed}, round ${round})`);

        if (result.accepted) {
          allEvents.push(...batchEvents);
          for (const d of batch.deps!) allEvents.find((e) => e.id === d.id)!.deps.push(d.dep);
          crossCheck();
        } else {
          assert.ok(result.conflicts.length > 0 || result.cycles.length > 0);
          crossCheck(); // state unchanged, still consistent
        }
      } else if (op < 0.8) {
        const n = Math.floor(rand() * 3);
        if (n <= store.unpublished.length) {
          store.publish(n);
          crossCheck();
        }
      } else {
        // snapshot round-trip, then continue incrementally from the restored store
        const restored = LogStore.fromSnapshot(store.toSnapshot());
        assert.deepEqual(restored.order, store.order);
        store = restored;
        crossCheck();
      }
    }
  }
});
