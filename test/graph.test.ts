import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VersionGraph,
  computeDigest,
  makeDelta,
  type Delta,
} from "../src/index.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rand() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

/** Random DAG: roots, single-parent deltas, and occasional merges. */
function randomDag(count: number, rand: () => number): Delta[] {
  const deltas: Delta[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `v${index}`;
    const parents: string[] = [];
    if (index > 0 && rand() > 0.08) {
      const first = Math.floor(rand() * index);
      parents.push(`v${first}`);
      if (rand() < 0.2) {
        const second = Math.floor(rand() * index);
        if (second !== first) parents.push(`v${second}`);
      }
    }
    deltas.push(makeDelta(id, parents, { seq: index, noise: rand() }));
  }
  return deltas;
}

function replay(deltas: readonly Delta[]): VersionGraph {
  const graph = new VersionGraph();
  for (const delta of deltas) graph.apply(delta);
  return graph;
}

function assertTopological(graph: VersionGraph, head: string): void {
  const order = graph.history(head).map((delta) => delta.id);
  const position = new Map(order.map((id, index) => [id, index]));
  for (const delta of graph.history(head)) {
    for (const parent of delta.parents) {
      assert.ok(
        position.get(parent)! < position.get(delta.id)!,
        `${parent} must precede ${delta.id}`,
      );
    }
  }
}

test("digest is deterministic and detects tampering", () => {
  const delta = makeDelta("a", [], { b: 1, a: [2, 3] });
  assert.equal(computeDigest("a", [], { a: [2, 3], b: 1 }), delta.digest);
  const tampered: Delta = { ...delta, payload: { b: 1, a: [2, 4] } };
  const graph = new VersionGraph();
  assert.equal(graph.apply(tampered).status, "bad-digest");
  assert.ok(graph.isQuarantined("a"));
});

test("in-order deltas form a linear chain with a single head", () => {
  const graph = new VersionGraph();
  const deltas = [
    makeDelta("r", [], "root"),
    makeDelta("a", ["r"], "a"),
    makeDelta("b", ["a"], "b"),
  ];
  for (const delta of deltas) {
    assert.equal(graph.apply(delta).status, "applied");
  }
  assert.deepEqual(graph.heads(), ["b"]);
  assert.deepEqual(
    graph.history("b").map((delta) => delta.id),
    ["r", "a", "b"],
  );
});

test("out-of-order deltas are buffered and promoted when parents arrive", () => {
  const graph = new VersionGraph();
  const c = makeDelta("c", ["b"], "c");
  const b = makeDelta("b", ["a"], "b");
  const a = makeDelta("a", [], "a");
  assert.deepEqual(graph.apply(c), {
    id: "c",
    status: "buffered",
    missingParents: ["b"],
  });
  assert.deepEqual(graph.apply(b).missingParents, ["a"]);
  assert.deepEqual(graph.pendingIds().sort(), ["b", "c"]);
  assert.equal(graph.apply(a).status, "applied");
  assert.deepEqual(graph.pendingIds(), []);
  assert.deepEqual(graph.heads(), ["c"]);
  assert.deepEqual(
    graph.history("c").map((delta) => delta.id),
    ["a", "b", "c"],
  );
});

test("branches are not linearized; queries must name a head", () => {
  const graph = new VersionGraph();
  const deltas = [
    makeDelta("r", [], 0),
    makeDelta("x1", ["r"], 1),
    makeDelta("x2", ["x1"], 2),
    makeDelta("y1", ["r"], 3),
  ];
  for (const delta of deltas) graph.apply(delta);
  assert.deepEqual(graph.heads(), ["x2", "y1"]);
  assert.throws(() => graph.history(""), /explicit branch head/);
  assert.throws(() => graph.history("nope"), /unknown head/);
  assert.deepEqual(
    graph.history("x2").map((delta) => delta.id),
    ["r", "x1", "x2"],
  );
  assert.deepEqual(
    graph.history("y1").map((delta) => delta.id),
    ["r", "y1"],
  );
  assert.equal(
    graph.materialize("x2", 0, (sum, payload) => sum + (payload as number)),
    3,
  );
});

test("merge delta joins two branches into one head", () => {
  const graph = new VersionGraph();
  const deltas = [
    makeDelta("r", [], "r"),
    makeDelta("x", ["r"], "x"),
    makeDelta("y", ["r"], "y"),
    makeDelta("m", ["x", "y"], "m"),
  ];
  for (const delta of deltas) graph.apply(delta);
  assert.deepEqual(graph.heads(), ["m"]);
  const history = graph.history("m").map((delta) => delta.id);
  assert.deepEqual(history, ["r", "x", "y", "m"]);
  assertTopological(graph, "m");
});

test("bad digest quarantines the delta and all of its successors", () => {
  const good = (id: string, parents: string[]) =>
    makeDelta(id, parents, `payload-${id}`);
  const rotten = good("b", ["a"]);
  const forged: Delta = { ...rotten, payload: "forged" };
  const graph = new VersionGraph();
  graph.apply(good("a", []));
  assert.equal(graph.apply(forged).status, "bad-digest");
  assert.equal(graph.apply(good("c", ["b"])).status, "quarantined");
  assert.equal(graph.apply(good("d", ["c"])).status, "quarantined");
  assert.equal(graph.apply(good("z", ["a"])).status, "applied");
  assert.deepEqual(graph.quarantinedIds(), ["b", "c", "d"]);
  assert.deepEqual(graph.heads(), ["z"]);
  assert.throws(() => graph.history("c"), /quarantined/);
  assert.deepEqual(
    graph.history("z").map((delta) => delta.id),
    ["a", "z"],
  );
});

test("quarantine cascades to successors buffered before the bad parent", () => {
  const graph = new VersionGraph();
  const forged: Delta = { ...makeDelta("p", [], 1), payload: 999 };
  const child = makeDelta("c", ["p"], 2);
  const grandchild = makeDelta("g", ["c"], 3);
  assert.equal(graph.apply(grandchild).status, "buffered");
  assert.equal(graph.apply(child).status, "buffered");
  assert.equal(graph.apply(forged).status, "bad-digest");
  assert.deepEqual(graph.pendingIds(), []);
  assert.deepEqual(graph.quarantinedIds(), ["c", "g", "p"]);
  assert.deepEqual(graph.appliedIds(), []);
});

test("out-of-order replay matches full version-graph construction", () => {
  for (const seed of [1, 7, 42, 1337, 20261005]) {
    const rand = mulberry32(seed);
    const dag = randomDag(80, rand);
    const arrival = shuffled(dag, rand);
    const replayed = replay(arrival);
    const full = VersionGraph.buildFull(dag);
    assert.ok(
      replayed.equals(full),
      `seed ${seed}: replay and full build diverge`,
    );
    for (const head of full.heads()) assertTopological(full, head);
  }
});

test("replay matches full build when a forged delta splits the graph", () => {
  for (const seed of [3, 11, 99]) {
    const rand = mulberry32(seed);
    const dag = randomDag(60, rand);
    const victimIndex = dag.findIndex(
      (delta) => delta.parents.length > 0,
    );
    const victim = dag[victimIndex]!;
    const forged: Delta = { ...victim, payload: { forged: true } };
    const batch = dag.map((delta, index) =>
      index === victimIndex ? forged : delta,
    );
    const replayed = replay(shuffled(batch, rand));
    const full = VersionGraph.buildFull(batch);
    assert.ok(replayed.equals(full), `seed ${seed}: divergence`);
    assert.ok(full.quarantinedIds().includes(victim.id));
    for (const head of full.heads()) {
      assert.ok(!full.history(head).some((delta) => delta.id === victim.id));
    }
  }
});

test("deltas with parents outside the batch stay buffered in both modes", () => {
  const orphan = makeDelta("orphan", ["never-arrives"], 1);
  const child = makeDelta("child", ["orphan"], 2);
  const replayed = replay([child, orphan]);
  const full = VersionGraph.buildFull([orphan, child]);
  assert.deepEqual(replayed.pendingIds(), ["child", "orphan"]);
  assert.ok(replayed.equals(full));
});

test("duplicates are idempotent", () => {
  const graph = new VersionGraph();
  const delta = makeDelta("a", [], 1);
  assert.equal(graph.apply(delta).status, "applied");
  assert.equal(graph.apply(delta).status, "duplicate");
  assert.deepEqual(graph.appliedIds(), ["a"]);
});
