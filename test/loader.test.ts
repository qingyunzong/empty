import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import {
  Registry,
  ModuleState,
  LEGAL_TRANSITIONS,
  verifyTrace,
  LinkError,
  UninitializedBindingError,
  DependencyFailedError,
  InvalidTransitionError,
  type TraceEvent,
} from "../src/loader";

function evaluateStarts(trace: readonly TraceEvent[]): string[] {
  return trace.filter((e) => e.type === "evaluate:start").map((e) => e.module!);
}

describe("static linking", () => {
  test("resolves imports to exporter bindings before any body runs", () => {
    const reg = new Registry();
    const ran: string[] = [];
    reg.define({
      name: "b",
      exports: ["x"],
      body: (api) => {
        ran.push("b");
        api.export("x", 42);
      },
    });
    reg.define({
      name: "a",
      imports: { x: { from: "b" } },
      body: (api) => {
        ran.push("a");
        assert.equal(api.import("x"), 42);
      },
    });
    reg.link("a");
    assert.equal(reg.stateOf("a"), ModuleState.Linked);
    assert.equal(reg.stateOf("b"), ModuleState.Linked);
    assert.deepEqual(ran, []); // linking runs no code
    assert.equal(reg.record("a").resolvedImports.get("x")!.record.name, "b");
    reg.evaluate("a");
    assert.deepEqual(ran, ["b", "a"]);
    assert.equal(verifyTrace(reg.trace()).length, 0);
  });

  test("fails linking on unknown module and on missing export", () => {
    const reg = new Registry();
    reg.define({ name: "a", imports: { x: { from: "ghost" } }, body: () => {} });
    assert.throws(() => reg.link("a"), LinkError);
    assert.equal(reg.stateOf("a"), ModuleState.Failed);

    const reg2 = new Registry();
    reg2.define({ name: "b", exports: ["y"], body: () => {} });
    reg2.define({ name: "c", imports: { nope: { from: "b" } }, body: () => {} });
    assert.throws(
      () => reg2.link("c"),
      (err) => err instanceof LinkError && /does not export 'nope'/.test(err.message),
    );
    assert.equal(reg2.stateOf("c"), ModuleState.Failed);
    assert.equal(reg2.stateOf("b"), ModuleState.Linked);
    assert.equal(verifyTrace(reg2.trace()).length, 0);
  });
});

describe("depth-ordered initialization", () => {
  test("evaluates deepest leaves first in a diamond graph", () => {
    const reg = new Registry();
    reg.define({ name: "base", exports: ["v"], body: (api) => api.export("v", 1) });
    reg.define({
      name: "left",
      imports: { v: { from: "base" } },
      exports: ["v"],
      body: (api) => api.export("v", api.import("v")),
    });
    reg.define({
      name: "right",
      imports: { v: { from: "base" } },
      exports: ["v"],
      body: (api) => api.export("v", api.import("v")),
    });
    reg.define({
      name: "app",
      imports: { l: { from: "left", export: "v" }, r: { from: "right", export: "v" } },
      body: () => {},
    });
    reg.loadAll();
    assert.equal(reg.record("base").depth, 0);
    assert.equal(reg.record("left").depth, 1);
    assert.equal(reg.record("right").depth, 1);
    assert.equal(reg.record("app").depth, 2);
    assert.deepEqual(evaluateStarts(reg.trace()), ["base", "left", "right", "app"]);
    for (const name of ["base", "left", "right", "app"]) {
      assert.equal(reg.stateOf(name), ModuleState.Evaluated);
    }
    assert.equal(verifyTrace(reg.trace()).length, 0);
  });
});

describe("live bindings & TDZ", () => {
  test("imports observe later updates of the exporter's binding", () => {
    const reg = new Registry();
    reg.define({
      name: "counter",
      exports: ["count", "inc"],
      body: (api) => {
        let c = 0;
        api.export("count", c);
        api.export("inc", () => {
          c += 1;
          api.export("count", c); // update the live binding
        });
      },
    });
    reg.define({
      name: "main",
      imports: { count: { from: "counter" } },
      exports: ["getCount"],
      body: (api) => {
        assert.equal(api.import("count"), 0);
        api.export("getCount", () => api.import("count"));
      },
    });
    reg.load("main");
    const counter = reg.namespace("counter");
    const main = reg.namespace("main");
    assert.equal(counter.count, 0);
    (counter.inc as () => void)();
    assert.equal(counter.count, 1); // namespace getter is live
    assert.equal((main.getCount as () => unknown)(), 1); // import sees the update
    assert.equal(verifyTrace(reg.trace()).length, 0);
  });

  test("reading an uninitialized binding throws UninitializedBindingError", () => {
    const reg = new Registry();
    reg.define({ name: "lazy", exports: ["x"], body: () => {} }); // never sets x
    reg.load("lazy");
    assert.equal(reg.stateOf("lazy"), ModuleState.Evaluated);
    assert.throws(() => reg.namespace("lazy").x, UninitializedBindingError);
  });

  test("cyclic import across the TDZ fails with UninitializedBindingError", () => {
    const reg = new Registry();
    reg.define({
      name: "a",
      imports: { bval: { from: "b" } },
      exports: ["aval"],
      body: (api) => api.export("aval", "A"),
    });
    reg.define({
      name: "b",
      imports: { aval: { from: "a" } },
      exports: ["bval"],
      body: (api) => api.export("bval", String(api.import("aval")) + "B"), // reads a too early
    });
    assert.throws(() => reg.load("a"), DependencyFailedError);
    assert.equal(reg.stateOf("a"), ModuleState.Failed);
    assert.equal(reg.stateOf("b"), ModuleState.Failed);
    assert.ok(reg.record("b").error instanceof UninitializedBindingError);
    assert.ok(reg.record("a").error instanceof DependencyFailedError);
    assert.equal(verifyTrace(reg.trace()).length, 0);
  });
});

describe("cycles", () => {
  test("a cycle never executes a module body twice", () => {
    const reg = new Registry();
    const executions = { a: 0, b: 0 };
    reg.define({
      name: "a",
      imports: { bval: { from: "b" } },
      exports: ["aval"],
      body: (api) => {
        executions.a += 1;
        api.export("aval", "A");
      },
    });
    reg.define({
      name: "b",
      imports: { aval: { from: "a" } },
      exports: ["bval"],
      body: (api) => {
        executions.b += 1;
        api.export("bval", "B"); // does not touch a's uninitialized export
      },
    });
    reg.load("a");
    assert.deepEqual(executions, { a: 1, b: 1 });
    assert.equal(reg.stateOf("a"), ModuleState.Evaluated);
    assert.equal(reg.stateOf("b"), ModuleState.Evaluated);
    // evaluating again is a no-op, still exactly one execution each
    reg.evaluate("a");
    reg.evaluate("b");
    assert.deepEqual(executions, { a: 1, b: 1 });
    assert.equal(verifyTrace(reg.trace()).length, 0);
  });
});

describe("failure propagation", () => {
  test("a throwing dependency fails its dependents without running their bodies", () => {
    const reg = new Registry();
    const boom = new Error("boom");
    let aRan = false;
    reg.define({
      name: "b",
      exports: ["x"],
      body: () => {
        throw boom;
      },
    });
    reg.define({
      name: "a",
      imports: { x: { from: "b" } },
      body: () => {
        aRan = true;
      },
    });
    assert.throws(() => reg.load("a"), DependencyFailedError);
    assert.equal(aRan, false);
    assert.equal(reg.stateOf("a"), ModuleState.Failed);
    assert.equal(reg.stateOf("b"), ModuleState.Failed);
    assert.equal(reg.record("b").error, boom);
    const aErr = reg.record("a").error as DependencyFailedError;
    assert.ok(aErr instanceof DependencyFailedError);
    assert.equal(aErr.dependency, "b");
    // re-evaluating a failed module rethrows instead of re-running
    assert.throws(() => reg.evaluate("a"), DependencyFailedError);
    assert.equal(verifyTrace(reg.trace()).length, 0);
  });
});

describe("generational reset", () => {
  test("reset starts a new generation; old failed records stay failed", () => {
    const reg = new Registry();
    let shouldFail = true;
    reg.define({
      name: "flaky",
      exports: ["v"],
      body: (api) => {
        if (shouldFail) throw new Error("generation 0 failure");
        api.export("v", "ok");
      },
    });
    assert.throws(() => reg.load("flaky"), /generation 0 failure/);
    const gen0 = reg.record("flaky");
    assert.equal(gen0.state, ModuleState.Failed);
    assert.equal(gen0.generation, 0);

    assert.equal(reg.reset(), 1);
    assert.equal(reg.generation, 1);
    const gen1 = reg.record("flaky");
    assert.notEqual(gen1, gen0);
    assert.equal(gen1.state, ModuleState.Unlinked);
    assert.equal(gen1.generation, 1);
    assert.equal(gen0.state, ModuleState.Failed); // old generation untouched

    shouldFail = false;
    reg.load("flaky");
    assert.equal(reg.stateOf("flaky"), ModuleState.Evaluated);
    assert.equal(reg.namespace("flaky").v, "ok");

    const trace = reg.trace();
    const resetEvents = trace.filter((e) => e.type === "reset");
    assert.equal(resetEvents.length, 1);
    assert.equal(resetEvents[0]!.generation, 1);
    // every event after the reset belongs to generation 1
    const resetSeq = resetEvents[0]!.seq;
    for (const e of trace.filter((e) => e.seq > resetSeq)) {
      assert.equal(e.generation, 1);
    }
    assert.equal(verifyTrace(trace).length, 0);
  });
});

describe("state machine", () => {
  test("evaluating an unlinked module is an invalid transition", () => {
    const reg = new Registry();
    reg.define({ name: "m", body: () => {} });
    assert.throws(() => reg.evaluate("m"), InvalidTransitionError);
  });

  test("verifyTrace flags an illegal transition in a forged trace", () => {
    const forged: TraceEvent[] = [
      { seq: 0, generation: 0, type: "transition", module: "m", from: "Unlinked", to: "Evaluated" },
    ];
    const violations = verifyTrace(forged);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.message, /illegal transition Unlinked -> Evaluated/);
  });

  test("every state appears in the transition table", () => {
    for (const state of Object.values(ModuleState)) {
      assert.ok(state in LEGAL_TRANSITIONS, `missing ${state}`);
    }
    assert.deepEqual(LEGAL_TRANSITIONS.Evaluated, []);
    assert.deepEqual(LEGAL_TRANSITIONS.Failed, []);
  });
});
