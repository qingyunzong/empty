import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ModuleLoader,
  LinkError,
  UninitializedBindingError,
  isValidTransition,
  STATE_MACHINE,
  type ModuleState,
  type TraceEvent,
} from "../src/loader.js";

function stateEvents(loader: ModuleLoader, module: string): TraceEvent[] {
  return loader.trace.filter((e) => e.type === "state" && e.module === module);
}

test("static linking resolves imports/exports and initializes by dependency depth", () => {
  const loader = new ModuleLoader();
  const executed: string[] = [];

  // Diamond: app -> [left, right], left -> base, right -> base.
  loader.define("base", {
    exports: ["value"],
    evaluate: (ctx) => {
      executed.push("base");
      ctx.set("value", 1);
    },
  });
  loader.define("left", {
    imports: [{ from: "base", names: ["value"] }],
    exports: ["leftValue"],
    evaluate: (ctx) => {
      executed.push("left");
      ctx.set("leftValue", (ctx.get("value") as number) + 10);
    },
  });
  loader.define("right", {
    imports: [{ from: "base", names: ["value"] }],
    exports: ["rightValue"],
    evaluate: (ctx) => {
      executed.push("right");
      ctx.set("rightValue", (ctx.get("value") as number) + 20);
    },
  });
  loader.define("app", {
    imports: [
      { from: "left", names: ["leftValue"] },
      { from: "right", names: ["rightValue"] },
    ],
    exports: ["result"],
    evaluate: (ctx) => {
      executed.push("app");
      ctx.set("result", (ctx.get("leftValue") as number) + (ctx.get("rightValue") as number));
    },
  });

  loader.evaluate("app");

  // Dependencies initialize before dependents; shared dep runs once.
  assert.deepEqual(executed, ["base", "left", "right", "app"]);
  assert.equal(loader.read("app", "result"), 32);

  // Dependency depth is computed statically at link time.
  assert.equal(loader.depthOf("base"), 0);
  assert.equal(loader.depthOf("left"), 1);
  assert.equal(loader.depthOf("right"), 1);
  assert.equal(loader.depthOf("app"), 2);

  // Evaluation finish order respects depth ordering.
  assert.ok(loader.evaluationOrderOf("base") < loader.evaluationOrderOf("left"));
  assert.ok(loader.evaluationOrderOf("left") < loader.evaluationOrderOf("app"));
  assert.ok(loader.evaluationOrderOf("right") < loader.evaluationOrderOf("app"));

  // Trace records evaluate start/success in the same order.
  const evalStarts = loader.trace
    .filter((e) => e.type === "evaluate" && e.detail === "start")
    .map((e) => e.module);
  assert.deepEqual(evalStarts, ["app", "left", "base", "right"]);
  const evalSuccesses = loader.trace
    .filter((e) => e.type === "evaluate" && e.detail === "success")
    .map((e) => e.module);
  assert.deepEqual(evalSuccesses, ["base", "left", "right", "app"]);
});

test("re-exports are linked statically and resolve to the original slot", () => {
  const loader = new ModuleLoader();
  loader.define("core", {
    exports: ["answer"],
    evaluate: (ctx) => ctx.set("answer", 42),
  });
  loader.define("facade", {
    reexports: [{ from: "core", names: ["answer"] }],
  });
  loader.define("consumer", {
    imports: [{ from: "facade", names: ["answer"] }],
    exports: ["doubled"],
    evaluate: (ctx) => ctx.set("doubled", (ctx.get("answer") as number) * 2),
  });

  loader.evaluate("consumer");
  assert.equal(loader.read("consumer", "doubled"), 84);
  assert.equal(loader.read("facade", "answer"), 42);
});

test("imports are live bindings reflecting later updates", () => {
  const loader = new ModuleLoader();
  loader.define("counter", {
    exports: ["count", "increment"],
    evaluate: (ctx) => {
      ctx.set("count", 0);
      ctx.set("increment", () => ctx.set("count", (ctx.get("count") as number) + 1));
    },
  });
  const snapshots: number[] = [];
  loader.define("reader", {
    imports: [{ from: "counter", names: ["count", "increment"] }],
    exports: ["first", "second"],
    evaluate: (ctx) => {
      snapshots.push(ctx.get("count") as number);
      (ctx.get("increment") as () => void)();
      (ctx.get("increment") as () => void)();
      snapshots.push(ctx.get("count") as number);
      ctx.set("first", snapshots[0]);
      ctx.set("second", snapshots[1]);
    },
  });

  loader.evaluate("reader");
  assert.deepEqual(snapshots, [0, 2]);
  // The host-side read observes the same live slot.
  assert.equal(loader.read("counter", "count"), 2);
  assert.equal(loader.read("reader", "second"), 2);
});

test("reading an uninitialized binding throws UninitializedBindingError", () => {
  const loader = new ModuleLoader();
  // Cycle a -> b -> a; b evaluates first and reads a's binding too early.
  loader.define("a", {
    imports: [{ from: "b", names: ["bReady"] }],
    exports: ["aValue"],
    evaluate: (ctx) => {
      ctx.get("bReady");
      ctx.set("aValue", "a");
    },
  });
  loader.define("b", {
    imports: [{ from: "a", names: ["aValue"] }],
    exports: ["bReady"],
    evaluate: (ctx) => {
      ctx.get("aValue"); // a has not evaluated yet -> TDZ-like error
      ctx.set("bReady", true);
    },
  });

  assert.throws(
    () => loader.evaluate("a"),
    (err: unknown) => {
      assert.ok(err instanceof UninitializedBindingError);
      assert.match(
        (err as Error).message,
        /uninitialized binding 'aValue' of module 'a' \(requested by 'b'\)/,
      );
      return true;
    },
  );
  assert.equal(loader.stateOf("a"), "failed");
  assert.equal(loader.stateOf("b"), "failed");
});

test("cyclic modules execute exactly once", () => {
  const loader = new ModuleLoader();
  const counts = new Map<string, number>();
  const run = (name: string) => () => counts.set(name, (counts.get(name) ?? 0) + 1);

  loader.define("p", {
    imports: [{ from: "q", names: ["qDone"] }],
    exports: ["pDone"],
    evaluate: (ctx) => {
      run("p")();
      ctx.set("pDone", true);
    },
  });
  loader.define("q", {
    imports: [{ from: "p", names: ["pDone"] }],
    exports: ["qDone"],
    evaluate: (ctx) => {
      run("q")();
      ctx.set("qDone", true);
    },
  });

  loader.evaluate("p");
  assert.equal(counts.get("p"), 1);
  assert.equal(counts.get("q"), 1);
  assert.equal(loader.stateOf("p"), "evaluated");
  assert.equal(loader.stateOf("q"), "evaluated");

  // Re-evaluating either module is a no-op within the same generation.
  loader.evaluate("q");
  loader.evaluate("p");
  assert.equal(counts.get("p"), 1);
  assert.equal(counts.get("q"), 1);
});

test("evaluation failure propagates to dependents and is terminal within a generation", () => {
  const loader = new ModuleLoader();
  const boom = new Error("boom");
  let leafRuns = 0;

  loader.define("leaf", {
    exports: ["x"],
    evaluate: () => {
      leafRuns += 1;
      throw boom;
    },
  });
  loader.define("mid", { imports: [{ from: "leaf", names: ["x"] }], exports: ["y"] });
  loader.define("top", { imports: [{ from: "mid", names: ["y"] }], exports: ["z"] });
  loader.define("untouched", {
    exports: ["ok"],
    evaluate: (ctx) => ctx.set("ok", true),
  });

  assert.throws(() => loader.evaluate("top"), (err: unknown) => err === boom);
  assert.equal(loader.stateOf("leaf"), "failed");
  assert.equal(loader.stateOf("mid"), "failed");
  assert.equal(loader.stateOf("top"), "failed");

  // The same error object propagates through the whole chain.
  const topError = stateEvents(loader, "top");
  assert.deepEqual(topError.at(-1)?.to, "failed");

  // Failure is terminal: re-evaluating rethrows without re-executing.
  assert.throws(() => loader.evaluate("top"), (err: unknown) => err === boom);
  assert.equal(leafRuns, 1);

  // Independent modules are unaffected.
  loader.evaluate("untouched");
  assert.equal(loader.read("untouched", "ok"), true);
});

test("a failed dependency dooms a pending dependent without executing it", () => {
  const loader = new ModuleLoader();
  let dependentRan = false;
  loader.define("bad", {
    exports: ["v"],
    evaluate: () => {
      throw new Error("bad module");
    },
  });
  loader.define("first", { imports: [{ from: "bad", names: ["v"] }], exports: ["a"] });
  loader.define("second", {
    imports: [{ from: "bad", names: ["v"] }],
    exports: ["b"],
    evaluate: () => {
      dependentRan = true;
    },
  });
  loader.define("root", {
    imports: [
      { from: "first", names: ["a"] },
      { from: "second", names: ["b"] },
    ],
  });

  assert.throws(() => loader.evaluate("root"), /bad module/);
  // 'second' was never reached during root's evaluation; it stays linked.
  assert.equal(loader.stateOf("second"), "linked");
  // Evaluating it afterwards fails immediately via the failed dependency,
  // without executing its body.
  assert.throws(() => loader.evaluate("second"), /bad module/);
  assert.equal(loader.stateOf("second"), "failed");
  assert.equal(dependentRan, false);
  // It went straight linked -> failed, never through 'evaluating'.
  assert.deepEqual(loader.stateHistoryOf("second"), [
    "unlinked->linking",
    "linking->linked",
    "linked->failed",
  ]);
});

test("reset requires a new generation and allows re-evaluation", () => {
  const loader = new ModuleLoader();
  let shouldThrow = true;
  let runs = 0;

  loader.define("flaky", {
    exports: ["value"],
    evaluate: (ctx) => {
      runs += 1;
      if (shouldThrow) throw new Error("transient failure");
      ctx.set("value", "recovered");
    },
  });

  assert.throws(() => loader.evaluate("flaky"), /transient failure/);
  assert.equal(loader.stateOf("flaky"), "failed");
  assert.equal(runs, 1);

  // Same generation: the failure sticks, the body does not re-run.
  assert.throws(() => loader.evaluate("flaky"), /transient failure/);
  assert.equal(runs, 1);

  // Redefining within a generation is rejected.
  assert.throws(() => loader.define("flaky", {}), /already defined/);

  // Reset starts a new generation; the module can be evaluated again.
  shouldThrow = false;
  loader.reset();
  assert.equal(loader.generation, 1);
  assert.equal(loader.stateOf("flaky"), "unlinked");

  loader.evaluate("flaky");
  assert.equal(runs, 2);
  assert.equal(loader.read("flaky", "value"), "recovered");

  // The trace separates generations explicitly.
  const resetEvent = loader.trace.find((e) => e.type === "reset");
  assert.ok(resetEvent);
  assert.equal(resetEvent.generation, 1);
  const gen0Failures = loader.trace.filter(
    (e) => e.generation === 0 && e.type === "state" && e.to === "failed",
  );
  const gen1Successes = loader.trace.filter(
    (e) => e.generation === 1 && e.type === "state" && e.to === "evaluated",
  );
  assert.equal(gen0Failures.length, 1);
  assert.equal(gen1Successes.length, 1);
});

test("explicit state machine: transition table and observed traces", () => {
  // The transition table itself.
  assert.deepEqual(STATE_MACHINE.unlinked, ["linking"]);
  assert.deepEqual(STATE_MACHINE.linking, ["linked", "failed"]);
  assert.deepEqual(STATE_MACHINE.linked, ["evaluating", "failed"]);
  assert.deepEqual(STATE_MACHINE.evaluating, ["evaluated", "failed"]);
  assert.deepEqual(STATE_MACHINE.evaluated, []);
  assert.deepEqual(STATE_MACHINE.failed, []);
  assert.ok(isValidTransition("evaluating", "evaluated"));
  assert.ok(!isValidTransition("unlinked", "evaluated"));
  assert.ok(!isValidTransition("evaluated", "evaluating"));
  assert.ok(!isValidTransition("failed", "linked"));

  // Happy path: the full transition sequence is observable in the trace.
  const loader = new ModuleLoader();
  loader.define("m", { exports: ["v"], evaluate: (ctx) => ctx.set("v", 1) });
  loader.evaluate("m");
  assert.deepEqual(loader.stateHistoryOf("m"), [
    "unlinked->linking",
    "linking->linked",
    "linked->evaluating",
    "evaluating->evaluated",
  ]);

  // Link failure path: linking -> failed.
  const loader2 = new ModuleLoader();
  loader2.define("broken", { imports: [{ from: "ghost", names: ["x"] }] });
  assert.throws(() => loader2.link("broken"), LinkError);
  assert.deepEqual(loader2.stateHistoryOf("broken"), [
    "unlinked->linking",
    "linking->failed",
  ]);

  // Evaluation failure path: evaluating -> failed.
  const loader3 = new ModuleLoader();
  loader3.define("thrower", {
    evaluate: () => {
      throw new Error("nope");
    },
  });
  assert.throws(() => loader3.evaluate("thrower"), /nope/);
  assert.deepEqual(loader3.stateHistoryOf("thrower"), [
    "unlinked->linking",
    "linking->linked",
    "linked->evaluating",
    "evaluating->failed",
  ]);
});

test("link errors: missing module, missing export, ambiguous re-export", () => {
  const loader = new ModuleLoader();
  loader.define("needsGhost", { imports: [{ from: "ghost", names: ["x"] }] });
  assert.throws(
    () => loader.link("needsGhost"),
    (err: unknown) => {
      assert.ok(err instanceof LinkError);
      assert.match((err as Error).message, /module 'ghost' is not defined/);
      return true;
    },
  );
  assert.equal(loader.stateOf("needsGhost"), "failed");

  loader.define("provider", { exports: ["real"] });
  loader.define("needsFake", { imports: [{ from: "provider", names: ["fake"] }] });
  assert.throws(
    () => loader.link("needsFake"),
    /module 'provider' does not provide export 'fake'/,
  );

  // Ambiguous re-export of the same name through two paths.
  loader.define("p", { exports: ["v"] });
  loader.define("q", { exports: ["v"] });
  loader.define("hub", {
    reexports: [
      { from: "p", names: ["v"] },
      { from: "q", names: ["v"] },
    ],
  });
  loader.define("user", { imports: [{ from: "hub", names: ["v"] }] });
  assert.throws(() => loader.link("user"), /ambiguous re-export 'v'/);
});

test("trace is ordered, sequential and generation-aware", () => {
  const loader = new ModuleLoader();
  loader.define("a", { exports: ["v"], evaluate: (ctx) => ctx.set("v", 1) });
  loader.define("b", { imports: [{ from: "a", names: ["v"] }], exports: ["w"] });
  loader.evaluate("b");
  loader.reset();
  loader.evaluate("b");

  // Sequence numbers are strictly increasing.
  const seqs = loader.trace.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));

  // Every event belongs to a known generation.
  const generations = new Set(loader.trace.map((e) => e.generation));
  assert.deepEqual([...generations].sort(), [0, 1]);

  // Event kinds used by the loader.
  const kinds = new Set(loader.trace.map((e) => e.type));
  assert.deepEqual([...kinds].sort(), ["define", "evaluate", "reset", "state"]);
});
