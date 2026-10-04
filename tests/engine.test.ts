import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AsyncEngine, IncrementalEngine } from "../src/engine.js";
import { fullCompile } from "../src/fullModel.js";

const CHAIN: Record<string, string> = {
  a: 'import { v_b } from "b";\nexport const v_a = 1;\n',
  b: 'import { v_c } from "c";\nexport const v_b = 1;\n',
  c: "export const v_c = 1;\n",
};

function chainEngine(): IncrementalEngine {
  const engine = new IncrementalEngine();
  for (const [name, source] of Object.entries(CHAIN)) engine.setModule(name, source);
  engine.update();
  return engine;
}

describe("implementation vs interface summaries", () => {
  test("interface-unchanged edit recompiles only the edited module", () => {
    const engine = chainEngine();
    const before = engine.artifactSnapshot();

    engine.setModule("c", "// scratch reworked\nconst tmp = 99;\nexport const v_c = 1;\n");
    const events = engine.update();

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].members, ["c"]);
    assert.notEqual(engine.artifactOf("c"), before.get("c"));
    assert.equal(engine.artifactOf("b"), before.get("b"));
    assert.equal(engine.artifactOf("a"), before.get("a"));
  });

  test("interface change propagates to dependents until interfaces stabilize", () => {
    const engine = chainEngine();
    const before = engine.artifactSnapshot();

    engine.setModule("c", "export const v_c = 2;\n");
    const events = engine.update();

    // b consumes c's interface, so b is recompiled; b's own interface is
    // unchanged, so the change does not propagate further to a.
    assert.deepEqual(
      events.map((event) => event.members),
      [["c"], ["b"]],
    );
    assert.notEqual(engine.artifactOf("c"), before.get("c"));
    assert.notEqual(engine.artifactOf("b"), before.get("b"));
    assert.equal(engine.artifactOf("a"), before.get("a"));
  });
});

describe("cyclic modules publish as one SCC batch", () => {
  function cyclicEngine(): IncrementalEngine {
    const engine = new IncrementalEngine();
    engine.setModule("x", 'import { v_y } from "y";\nexport const v_x = 1;\n');
    engine.setModule("y", 'import { v_x } from "x";\nexport const v_y = 1;\n');
    engine.setModule("z", 'import { v_x } from "x";\nexport const v_z = 1;\n');
    engine.update();
    return engine;
  }

  test("initial publish batches the cycle together", () => {
    const engine = cyclicEngine();
    assert.deepEqual(
      engine.compileLog.map((event) => event.members),
      [["x", "y"], ["z"]],
    );
  });

  test("editing one member republishes the whole cycle, dependents untouched", () => {
    const engine = cyclicEngine();
    const zBefore = engine.artifactOf("z");

    engine.setModule("y", 'import { v_x } from "x";\nconst t = 7;\nexport const v_y = 1;\n');
    const events = engine.update();

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].members, ["x", "y"]);
    assert.equal(engine.artifactOf("z"), zBefore);
  });

  test("interface change inside the cycle reaches external dependents", () => {
    const engine = cyclicEngine();
    const zBefore = engine.artifactOf("z");

    engine.setModule("x", 'import { v_y } from "y";\nexport const v_x = 2;\n');
    const events = engine.update();

    assert.deepEqual(
      events.map((event) => event.members),
      [["x", "y"], ["z"]],
    );
    assert.notEqual(engine.artifactOf("z"), zBefore);
  });
});

describe("stale compile tasks re-check their baseline", () => {
  test("a task scheduled before a newer edit is discarded, never committed", () => {
    const engine = new AsyncEngine();
    engine.setModule("a", "export const v_a = 1;\n");
    engine.setModule("b", 'import { v_a } from "a";\nexport const v_b = 1;\n');
    engine.settle();
    assert.equal(engine.pendingCount, 0);

    engine.setModule("a", "// v2\nexport const v_a = 1;\n");
    assert.equal(engine.schedule(), 1);

    // The world moves on before the queued task completes.
    engine.setModule("a", "// v3\nexport const v_a = 1;\n");
    engine.completeNext();

    assert.equal(engine.staleTasks.length, 1);
    engine.settle();
    assert.equal(engine.pendingCount, 0);

    const sources = new Map([
      ["a", "// v3\nexport const v_a = 1;\n"],
      ["b", 'import { v_a } from "a";\nexport const v_b = 1;\n'],
    ]);
    assert.deepEqual(engine.artifactSnapshot(), fullCompile(sources));
  });

  test("a task whose SCC dissolved is dropped", () => {
    const engine = new AsyncEngine();
    engine.setModule("x", 'import { v_y } from "y";\nexport const v_x = 1;\n');
    engine.setModule("y", 'import { v_x } from "x";\nexport const v_y = 1;\n');
    engine.settle();

    engine.setModule("x", 'import { v_y } from "y";\n// touch\nexport const v_x = 1;\n');
    assert.equal(engine.schedule(), 1);

    // Break the cycle: the old {x,y} batch no longer exists.
    engine.setModule("y", "export const v_y = 1;\n");
    engine.completeNext();
    assert.equal(engine.staleTasks.length, 1);

    engine.settle();
    const sources = new Map([
      ["x", 'import { v_y } from "y";\n// touch\nexport const v_x = 1;\n'],
      ["y", "export const v_y = 1;\n"],
    ]);
    assert.deepEqual(engine.artifactSnapshot(), fullCompile(sources));
  });
});
