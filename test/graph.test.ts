import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/graph.js";

describe("DependencyGraph", () => {
  test("recordDependencies replaces outgoing edges", () => {
    const g = new DependencyGraph();
    g.recordDependencies("a", ["b"]);
    assert.deepEqual([...g.dependents("b")], ["a"]);
    g.recordDependencies("a", ["c"]);
    assert.deepEqual([...g.dependents("b")], []);
    assert.deepEqual([...g.dependents("c")], ["a"]);
    assert.deepEqual([...g.dependencies("a")], ["c"]);
  });

  test("reverseClosure walks reverse edges transitively", () => {
    const g = new DependencyGraph();
    // app -> {libA, libB}; libA -> util; libB -> util; util -> file:util.ts
    g.recordDependencies("app", ["libA", "libB"]);
    g.recordDependencies("libA", ["util"]);
    g.recordDependencies("libB", ["util"]);
    g.recordDependencies("util", ["file:util.ts"]);
    g.recordDependencies("lonely", ["file:other.ts"]);

    const closure = g.reverseClosure(["file:util.ts"]);
    assert.deepEqual([...closure].sort(), ["app", "file:util.ts", "libA", "libB", "util"]);
    assert.ok(!closure.has("lonely"));

    const partial = g.reverseClosure(["libA"]);
    assert.deepEqual([...partial].sort(), ["app", "libA"]);
  });

  test("batch closure unions multiple changed keys", () => {
    const g = new DependencyGraph();
    g.recordDependencies("a", ["f1"]);
    g.recordDependencies("b", ["f2"]);
    g.recordDependencies("c", ["a", "b"]);
    const closure = g.reverseClosure(["f1", "f2"]);
    assert.deepEqual([...closure].sort(), ["a", "b", "c", "f1", "f2"]);
  });

  test("cycles() reports members and a valid evidence path", () => {
    const g = new DependencyGraph();
    g.recordDependencies("a", ["b"]);
    g.recordDependencies("b", ["c"]);
    g.recordDependencies("c", ["a"]);
    g.recordDependencies("d", ["a"]); // depends on the cycle but is not part of it
    g.recordDependencies("e", ["e"]); // self-loop

    const cycles = g.cycles();
    assert.equal(cycles.length, 2);

    const abc = cycles.find((c) => c.members.includes("a"));
    assert.ok(abc);
    assert.deepEqual(abc.members, ["a", "b", "c"]);
    const ev = abc.evidence;
    assert.equal(ev[0], ev[ev.length - 1], "evidence must be a closed path");
    assert.equal(ev.length, 4);
    for (let i = 0; i + 1 < ev.length; i++) {
      assert.ok(
        g.dependencies(ev[i] as string).has(ev[i + 1] as string),
        `edge ${ev[i]} -> ${ev[i + 1]} must exist`,
      );
    }

    const self = cycles.find((c) => c.members.includes("e"));
    assert.ok(self);
    assert.deepEqual(self.evidence, ["e", "e"]);
  });

  test("acyclic graphs report no cycles", () => {
    const g = new DependencyGraph();
    g.recordDependencies("a", ["b"]);
    g.recordDependencies("b", ["c"]);
    assert.deepEqual(g.cycles(), []);
  });
});
