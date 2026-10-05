import { test } from "node:test";
import * as assert from "node:assert/strict";
import { GraphReplica, type EdgeOp } from "../src/graph.ts";
import { findCycles, reachable, verifyCycleEvidence } from "../src/cycles.ts";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

test("addEdge mints a unique tag per add and exposes the edge", () => {
  const replica = new GraphReplica("A");
  const op1 = replica.addEdge("x", "y");
  const op2 = replica.addEdge("x", "y");
  assert.notEqual(op1.tag, op2.tag);
  assert.ok(replica.hasEdge("x", "y"));
  assert.deepEqual(replica.tagsOf("x", "y"), [op1.tag, op2.tag].sort());
});

test("removeEdge only removes tags observed at removal time", () => {
  const replica = new GraphReplica("A");
  const first = replica.addEdge("x", "y");
  const remove = replica.removeEdge("x", "y");
  assert.ok(remove);
  assert.deepEqual(remove.tags, [first.tag]);
  assert.ok(!replica.hasEdge("x", "y"));

  // A tag that was never observed by the remove is untouched.
  const late = replica.addEdge("x", "y");
  replica.apply(remove); // replayed/duplicated remove
  assert.ok(replica.hasEdge("x", "y"));
  assert.deepEqual(replica.tagsOf("x", "y"), [late.tag]);
});

test("concurrent add survives a concurrent remove (add-wins per tag)", () => {
  const a = new GraphReplica("A");
  const b = new GraphReplica("B");

  const seed = a.addEdge("x", "y");
  b.apply(seed);

  const concurrentAdd = b.addEdge("x", "y");
  const remove = a.removeEdge("x", "y"); // observed only `seed.tag`
  assert.ok(remove);

  a.apply(concurrentAdd);
  b.apply(remove);

  assert.ok(a.hasEdge("x", "y"));
  assert.ok(b.hasEdge("x", "y"));
  assert.equal(a.fingerprint(), b.fingerprint());
  assert.deepEqual(a.tagsOf("x", "y"), [concurrentAdd.tag]);
});

test("replicas converge under out-of-order and duplicate delivery", () => {
  const a = new GraphReplica("A");
  const b = new GraphReplica("B");

  // Build an op log with interleaved concurrent edits on both replicas.
  const log: EdgeOp[] = [];
  const emit = (replica: GraphReplica, op: EdgeOp | null): void => {
    if (op) log.push(op);
  };
  emit(a, a.addEdge("x", "y"));
  emit(a, a.addEdge("y", "z"));
  emit(b, b.addEdge("x", "y")); // concurrent with A's remove below
  emit(a, a.removeEdge("x", "y"));
  emit(b, b.addEdge("z", "x"));
  emit(a, a.addEdge("z", "w"));
  emit(b, b.removeEdge("y", "z")); // never observed on B: null, no-op
  emit(a, a.removeEdge("z", "w"));

  // Reference replica applies the log in order.
  const reference = new GraphReplica("ref");
  for (const op of log) reference.apply(op);

  // Many permuted replicas, each op delivered 1-3 times, converge.
  for (let seed = 1; seed <= 25; seed += 1) {
    const rand = lcg(seed);
    const replica = new GraphReplica(`r${seed}`);
    for (const op of shuffled(log, rand)) {
      const copies = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < copies; i += 1) replica.apply(op);
    }
    assert.equal(replica.fingerprint(), reference.fingerprint(), `seed ${seed}`);
  }

  // Concurrent add survived the concurrent remove on every replica.
  assert.ok(reference.hasEdge("x", "y"));
  assert.ok(!reference.hasEdge("z", "w"));
});

test("projection may contain cycles; they are reported, never auto-removed", () => {
  const replica = new GraphReplica("A");
  replica.addEdge("a", "b");
  replica.addEdge("b", "c");
  replica.addEdge("c", "a");
  replica.addEdge("c", "d");

  const before = replica.fingerprint();
  const projection = replica.project();
  const cycles = findCycles(projection);

  assert.deepEqual(cycles, [["a", "b", "c"]]);
  // Reporting is pure: no edge was deleted to break the cycle.
  assert.equal(replica.fingerprint(), before);
  assert.ok(replica.hasEdge("c", "a"));
});

test("independent reachability check verifies cycle evidence", () => {
  const replica = new GraphReplica("A");
  replica.addEdge("a", "b");
  replica.addEdge("b", "c");
  replica.addEdge("c", "a");
  replica.addEdge("d", "e"); // acyclic tail
  const projection = replica.project();

  for (const cycle of findCycles(projection)) {
    assert.ok(verifyCycleEvidence(projection, cycle), `cycle ${cycle}`);
  }

  // Reachability facts about the same projection.
  assert.ok(reachable(projection, "a", "c"));
  assert.ok(reachable(projection, "c", "a"));
  assert.ok(!reachable(projection, "e", "a"));

  // Fabricated evidence is rejected.
  assert.ok(!verifyCycleEvidence(projection, ["a", "b", "d"]));
  assert.ok(!verifyCycleEvidence(projection, ["d", "e"]));
  assert.ok(!verifyCycleEvidence(projection, []));
});

test("acyclic projections report no cycles", () => {
  const replica = new GraphReplica("A");
  replica.addEdge("a", "b");
  replica.addEdge("b", "c");
  replica.addEdge("a", "c");
  assert.deepEqual(findCycles(replica.project()), []);
});
