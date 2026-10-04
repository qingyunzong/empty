import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphReplica } from "../src/graph.js";
import type { Message } from "../src/graph.js";

/** Deterministic PRNG so convergence tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shuffle and duplicate messages, simulating an unreliable network. */
function scramble(messages: Message[], rand: () => number): Message[] {
  const withDupes: Message[] = [];
  for (const m of messages) {
    withDupes.push(m);
    if (rand() < 0.3) withDupes.push(m); // duplicate delivery
  }
  for (let i = withDupes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = withDupes[i] as Message;
    withDupes[i] = withDupes[j] as Message;
    withDupes[j] = tmp;
  }
  return withDupes;
}

test("addEdge generates a unique tag per add; edge is visible", () => {
  const r = new GraphReplica("A");
  const m1 = r.addEdge("x", "y");
  const m2 = r.addEdge("x", "y");
  assert.notEqual(m1.tag, m2.tag);
  assert.match(m1.tag, /^A#\d+$/);
  assert.ok(r.hasEdge("x", "y"));
  assert.deepEqual(r.edges(), [{ from: "x", to: "y" }]);
});

test("removeEdge deletes exactly the tags observed at remove time", () => {
  const r = new GraphReplica("A");
  const a1 = r.addEdge("x", "y");
  const a2 = r.addEdge("x", "y");
  const rm = r.removeEdge("x", "y");
  assert.deepEqual([...rm.tags].sort(), [a1.tag, a2.tag].sort());
  assert.ok(!r.hasEdge("x", "y"));
});

test("concurrent add survives a remove (add-wins)", () => {
  const a = new GraphReplica("A");
  const b = new GraphReplica("B");
  const addA = a.addEdge("x", "y");
  b.apply(addA); // b observes A's add
  const addB = b.addEdge("x", "y"); // concurrent add on B
  const rmA = a.removeEdge("x", "y"); // A removes only what it observed
  assert.deepEqual(rmA.tags, [addA.tag]);
  b.apply(rmA);
  a.apply(addB);
  assert.ok(a.hasEdge("x", "y"));
  assert.ok(b.hasEdge("x", "y"));
  assert.equal(a.stateSignature(), b.stateSignature());
});

test("out-of-order delivery: remove applied before its add still converges", () => {
  const src = new GraphReplica("A");
  const add = src.addEdge("x", "y");
  const rm = src.removeEdge("x", "y");

  const r = new GraphReplica("B");
  r.apply(rm); // remove arrives first
  r.apply(add); // add arrives late
  assert.ok(!r.hasEdge("x", "y"));
  assert.equal(r.stateSignature(), src.stateSignature());
});

test("duplicate messages are idempotent", () => {
  const src = new GraphReplica("A");
  const add = src.addEdge("x", "y");
  const rm = src.removeEdge("x", "y");

  const r = new GraphReplica("B");
  for (let i = 0; i < 3; i += 1) {
    r.apply(add);
    r.apply(rm);
  }
  assert.ok(!r.hasEdge("x", "y"));
  assert.equal(r.stateSignature(), src.stateSignature());
});

test("replicas converge under shuffled, duplicated broadcast", () => {
  const rand = mulberry32(42);
  const replicas = [new GraphReplica("A"), new GraphReplica("B"), new GraphReplica("C")];
  const nodes = ["n1", "n2", "n3", "n4", "n5"];

  // Each replica generates local operations without seeing the others.
  for (const r of replicas) {
    for (let i = 0; i < 20; i += 1) {
      const from = nodes[Math.floor(rand() * nodes.length)] as string;
      const to = nodes[Math.floor(rand() * nodes.length)] as string;
      if (rand() < 0.6) r.addEdge(from, to);
      else r.removeEdge(from, to);
    }
  }

  const all = replicas.flatMap((r) => r.outbox);
  const baseline = new GraphReplica("Z");
  for (const m of all) baseline.apply(m); // in-order reference

  for (const r of replicas) {
    for (const m of scramble(all, rand)) r.apply(m);
    assert.equal(r.stateSignature(), baseline.stateSignature());
  }
});

test("projection may contain cycles: reported, never auto-removed", () => {
  const r = new GraphReplica("A");
  r.addEdge("a", "b");
  r.addEdge("b", "c");
  r.addEdge("c", "a"); // closes a cycle
  r.addEdge("c", "d"); // acyclic tail

  const before = r.edges().length;
  const cycles = r.findCycles();
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0]?.nodes, ["a", "b", "c"]);
  assert.equal(r.edges().length, before, "findCycles must not delete edges");
  assert.ok(r.hasEdge("c", "a"));
});

test("self-loop is reported as a cycle", () => {
  const r = new GraphReplica("A");
  r.addEdge("a", "a");
  const cycles = r.findCycles();
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0]?.nodes, ["a"]);
});

test("acyclic projection reports no cycles", () => {
  const r = new GraphReplica("A");
  r.addEdge("a", "b");
  r.addEdge("b", "c");
  r.addEdge("a", "c");
  assert.deepEqual(r.findCycles(), []);
});

test("independent reachability check verifies cycle evidence", () => {
  const r = new GraphReplica("A");
  r.addEdge("a", "b");
  r.addEdge("b", "c");
  r.addEdge("c", "a");
  r.addEdge("x", "y"); // separate acyclic component

  const cycles = r.findCycles();
  assert.equal(cycles.length, 1);
  const nodes = cycles[0]?.nodes as string[];

  // Every consecutive pair (including wrap-around) is independently
  // reachable, and every cycle member reaches itself via a real path.
  for (let i = 0; i < nodes.length; i += 1) {
    const from = nodes[i] as string;
    const to = nodes[(i + 1) % nodes.length] as string;
    assert.ok(r.isReachable(from, to), `${from} should reach ${to}`);
    assert.ok(r.isReachable(from, from), `${from} should reach itself via the cycle`);
  }

  // Negative controls: no false cycle evidence in the acyclic component.
  assert.ok(r.isReachable("x", "y"));
  assert.ok(!r.isReachable("y", "x"));
  assert.ok(!r.isReachable("x", "x"));
});

test("cycle survives in projection after unrelated removes; gone only when its edges are removed", () => {
  const r = new GraphReplica("A");
  r.addEdge("a", "b");
  r.addEdge("b", "c");
  r.addEdge("c", "a");
  r.addEdge("d", "e");

  r.removeEdge("d", "e"); // unrelated remove
  assert.equal(r.findCycles().length, 1);

  r.removeEdge("b", "c"); // break the cycle explicitly
  assert.deepEqual(r.findCycles(), []);
  assert.ok(!r.isReachable("b", "b"));
});
