import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  InMemoryRemote,
  computePullPlan,
  fullMapDiff,
  hashKey,
  bitOf,
  type Path,
} from "../src/index.js";

function mapOf(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

/** Deterministic PRNG (mulberry32) for the fuzz tests. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMap(rand: () => number, pool: string[], maxKeys: number) {
  const map = new Map<string, string>();
  const count = Math.floor(rand() * maxKeys);
  for (let i = 0; i < count; i += 1) {
    const key = pool[Math.floor(rand() * pool.length)]!;
    map.set(key, `v${Math.floor(rand() * 1e9)}`);
  }
  return map;
}

/** Bit path of a key down the trie, as the string format InMemoryRemote logs. */
function keyPathPrefixes(key: string): Set<string> {
  const hex = hashKey(key);
  const prefixes = new Set<string>([""]);
  let path = "";
  for (let depth = 0; depth < 256; depth += 1) {
    path += String(bitOf(hex, depth));
    prefixes.add(path);
  }
  return prefixes;
}

test("identical replicas: empty plan, only the root is fetched", async () => {
  const entries = mapOf({ a: "1", b: "2", c: "3" });
  const remote = new InMemoryRemote(entries, 7);
  const plan = await computePullPlan(remote, entries);
  deepEqual(plan.pull, []);
  deepEqual(plan.remove, []);
  equal(plan.version, 7);
  // root fetch + final root re-validation, no subtree exploration
  equal(remote.fetchCount, 2);
});

test("single changed value: plan pulls exactly that key", async () => {
  const local = new Map<string, string>();
  const remoteEntries = new Map<string, string>();
  for (let i = 0; i < 200; i += 1) {
    local.set(`key-${i}`, `hash-${i}`);
    remoteEntries.set(`key-${i}`, `hash-${i}`);
  }
  remoteEntries.set("key-123", "hash-changed");

  const remote = new InMemoryRemote(remoteEntries);
  const plan = await computePullPlan(remote, local);

  deepEqual(plan.pull, ["key-123"]);
  deepEqual(plan.remove, []);

  // Only the branch leading to the changed key may be explored.
  const allowed = keyPathPrefixes("key-123");
  for (const path of remote.fetchedPaths) {
    ok(allowed.has(path), `unexpected fetch into equal subtree at "${path}"`);
  }
});

test("added and removed keys are both detected", async () => {
  const local = mapOf({ keep: "1", drop: "2", change: "old" });
  const remoteEntries = mapOf({ keep: "1", add: "3", change: "new" });
  const remote = new InMemoryRemote(remoteEntries);
  const plan = await computePullPlan(remote, local);
  deepEqual(plan.pull, ["add", "change"]);
  deepEqual(plan.remove, ["drop"]);
});

test("empty remote removes everything; empty local pulls everything", async () => {
  const full = mapOf({ a: "1", b: "2", c: "3" });

  const remoteEmpty = new InMemoryRemote(new Map());
  const plan1 = await computePullPlan(remoteEmpty, full);
  deepEqual(plan1.pull, []);
  deepEqual(plan1.remove, ["a", "b", "c"]);

  const remoteFull = new InMemoryRemote(full);
  const plan2 = await computePullPlan(remoteFull, new Map());
  deepEqual(plan2.pull, ["a", "b", "c"]);
  deepEqual(plan2.remove, []);
});

test("version change mid-sync restarts the branch and stays correct", async () => {
  const local = new Map<string, string>();
  const initial = new Map<string, string>();
  for (let i = 0; i < 64; i += 1) {
    local.set(`k${i}`, `v${i}`);
    initial.set(`k${i}`, `v${i}`);
  }
  // The remote starts out of sync so the traversal actually descends.
  initial.set("k10", "stale");
  const remote = new InMemoryRemote(initial, 1);

  // Mutate the remote after a few fetches, while the sync is running.
  const finalEntries = new Map(initial);
  finalEntries.set("k10", "updated");
  finalEntries.set("k50", "updated");
  finalEntries.delete("k20");
  finalEntries.set("k99", "brand-new");
  let fetches = 0;
  remote.onFetch = (_path: Path, store: InMemoryRemote) => {
    fetches += 1;
    if (fetches === 3) store.setEntries(finalEntries);
  };

  const plan = await computePullPlan(remote, local);
  remote.onFetch = undefined;

  deepEqual({ pull: [...plan.pull], remove: [...plan.remove] },
    fullMapDiff(local, finalEntries));
  equal(plan.version, 2);
  // A restart means more fetches than a clean run would need.
  ok(remote.fetchCount > 3, "expected the branch to be re-fetched");
});

test("repeated version changes keep restarting until stable", async () => {
  const local = mapOf({ a: "1", b: "2" });
  const remote = new InMemoryRemote(mapOf({ a: "1", b: "stale" }), 1);
  const stages = [
    mapOf({ a: "1", b: "stage1", c: "x" }),
    mapOf({ a: "1", b: "stage2" }),
    mapOf({ a: "1", b: "final", d: "4" }),
  ];
  let fetches = 0;
  remote.onFetch = (_path: Path, store: InMemoryRemote) => {
    fetches += 1;
    if (stages.length > 0 && fetches % 3 === 0) {
      store.setEntries(stages.shift()!);
    }
  };

  const plan = await computePullPlan(remote, local);
  remote.onFetch = undefined;

  deepEqual(plan.pull, ["b", "d"]);
  deepEqual(plan.remove, []);
  equal(plan.version, 4);
});

test("fuzz: pull plan always matches the full-map diff", async () => {
  const pool: string[] = [];
  for (let i = 0; i < 40; i += 1) pool.push(`key-${i}`);

  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = rng(seed);
    const local = randomMap(rand, pool, 30);
    const remoteEntries = randomMap(rand, pool, 30);
    const remote = new InMemoryRemote(remoteEntries, 1000 + seed);

    // In a third of the runs, mutate the remote once mid-sync.
    const finalEntries = new Map(remoteEntries);
    if (seed % 3 === 0) {
      finalEntries.set(`key-${Math.floor(rand() * 40)}`, "mutated");
      let fetches = 0;
      const trigger = 1 + Math.floor(rand() * 5);
      remote.onFetch = (_path: Path, store: InMemoryRemote) => {
        fetches += 1;
        if (fetches === trigger) store.setEntries(finalEntries);
      };
    }

    const plan = await computePullPlan(remote, local);
    const expected = fullMapDiff(local, remote.snapshot());
    deepEqual(
      { pull: [...plan.pull], remove: [...plan.remove] },
      expected,
      `seed ${seed}`,
    );
    equal(plan.version, remote.version, `seed ${seed}`);
  }
});

test("plan is minimal: no key outside the full-map diff is ever pulled", async () => {
  const rand = rng(42);
  const pool: string[] = [];
  for (let i = 0; i < 25; i += 1) pool.push(`k${i}`);
  for (let round = 0; round < 50; round += 1) {
    const local = randomMap(rand, pool, 20);
    const remoteEntries = randomMap(rand, pool, 20);
    const remote = new InMemoryRemote(remoteEntries);
    const plan = await computePullPlan(remote, local);
    const expected = fullMapDiff(local, remoteEntries);
    equal(plan.pull.length, expected.pull.length);
    equal(plan.remove.length, expected.remove.length);
  }
});
