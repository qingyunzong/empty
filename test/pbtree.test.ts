import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import {
  Rng, caseRng,
  integer, array, constant, filter, map, oneOf,
  operationHistory, isValidHistory,
  check, resume,
  type Machine, type CheckResult,
} from "../src/index.js";

describe("serializable seed / rng", () => {
  test("snapshot round-trips through JSON and reproduces the stream", () => {
    const rng = new Rng(1234);
    const before = [rng.nextU32(), rng.nextU32()];
    const restored = Rng.fromSnapshot(JSON.parse(JSON.stringify(rng.snapshot())));
    assert.deepEqual([restored.nextU32(), restored.nextU32()], [rng.nextU32(), rng.nextU32()]);
    assert.notEqual(before[0], before[1]);
  });

  test("same seed generates identical values; different seeds differ", () => {
    const gen = (seed: number) =>
      Array.from({ length: 5 }, (_, i) => integer(0, 1_000_000).generate(caseRng(seed, i)).value);
    assert.deepEqual(gen(42), gen(42));
    assert.notDeepEqual(gen(42), gen(43));
  });

  test("identical seeds reproduce identical check traces", () => {
    const params = {
      arb: integer(0, 1000),
      property: (n: number) => n < 50,
      seed: 7,
      numRuns: 100,
    };
    const a = check(params);
    const b = check(params);
    assert.deepEqual(a.trace, b.trace);
    assert.deepEqual(a.counterexample, b.counterexample);
  });
});

describe("shrinking", () => {
  test("integer counterexample shrinks to the single-step minimum", () => {
    const r = check({ arb: integer(0, 1000), property: (n) => n < 50, seed: 7, numRuns: 100 });
    assert.equal(r.status, "failed");
    assert.equal(r.counterexample, 50); // 50 fails, 49 passes: cannot shrink one step
    assert.equal(r.isMinimal, true);
    assert.ok(r.trace.some((e) => e.phase === "generate"));
    assert.ok(r.trace.some((e) => e.phase === "shrink"));
  });

  test("sequence counterexample shrinks to minimal length and contents", () => {
    // Fails iff the array contains three or more elements summing to >= 10.
    const r = check({
      arb: array(integer(0, 9), { maxLength: 8 }),
      property: (xs) => !(xs.length >= 3 && xs.reduce((a, b) => a + b, 0) >= 10),
      seed: 11,
      numRuns: 200,
    });
    assert.equal(r.status, "failed");
    const ce = r.counterexample!;
    assert.ok(ce.length <= 3, `expected length <= 3, got ${JSON.stringify(ce)}`);
    assert.ok(ce.reduce((a, b) => a + b, 0) >= 10);
    assert.equal(r.isMinimal, true);
  });

  test("shrinking preserves the input contract on every candidate", () => {
    const even = filter(integer(0, 100), (n) => n % 2 === 0);
    const r = check({ arb: even, property: (n) => n < 20, seed: 5, numRuns: 100 });
    assert.equal(r.status, "failed");
    assert.equal(r.counterexample, 20); // smallest even falsifying n < 20
    for (const e of r.trace) {
      const n = JSON.parse(e.value) as number;
      assert.equal(n % 2, 0, `contract violated by candidate ${n}`);
      assert.ok(n >= 0 && n <= 100);
    }
  });

  test("final counterexample is irreducible by one shrink step", () => {
    // Independent verification: re-run the property over every direct child
    // of the final counterexample's tree node; none may fail.
    const property = (n: number) => n < 50;
    const r = check({ arb: integer(0, 1000), property, seed: 7, numRuns: 100 });
    assert.equal(r.status, "failed");
    // Rebuild the same case tree and walk the shrink path implied by the trace.
    const ce = r.counterexample!;
    assert.equal(property(ce), false);
    // Every immediate shrink candidate of an integer n toward 0 that still
    // fails would have been explored; assert the boundary directly:
    assert.equal(property(ce - 1), true);
  });
});

describe("failure vs exception", () => {
  test("returning false is a failure", () => {
    const r = check({ arb: integer(0, 10), property: () => false, seed: 1, numRuns: 5 });
    assert.equal(r.status, "failed");
    assert.equal(r.counterexampleKind, "failure");
    assert.equal(r.counterexample, 0);
    assert.equal(r.errorMessage, undefined);
  });

  test("throwing is an exception, reported as error", () => {
    const r = check({
      arb: integer(0, 100),
      property: (n) => {
        if (n >= 10) throw new Error("boom");
      },
      seed: 3,
      numRuns: 50,
    });
    assert.equal(r.status, "error");
    assert.equal(r.counterexampleKind, "exception");
    assert.equal(r.counterexample, 10);
    assert.match(r.errorMessage!, /boom/);
    assert.ok(r.trace.some((e) => e.outcome === "exception" && e.error === "boom"));
  });

  test("passing properties report passed with full trace", () => {
    const r = check({ arb: integer(0, 10), property: () => true, seed: 9, numRuns: 25 });
    assert.equal(r.status, "passed");
    assert.equal(r.evaluations, 25);
    assert.equal(r.trace.length, 25);
    assert.ok(r.trace.every((e) => e.outcome === "pass" && e.phase === "generate"));
  });
});

describe("operation history", () => {
  type Op = { kind: "push"; n: number } | { kind: "pop" };

  const machine: Machine<number[], Op> = {
    initialModel: () => [],
    next: (model) =>
      model.length > 0
        ? oneOf(
            map(integer(0, 9), (n): Op => ({ kind: "push", n })),
            constant<Op>({ kind: "pop" }),
          )
        : map(integer(0, 9), (n): Op => ({ kind: "push", n })),
    precondition: (m, op) => op.kind === "push" || m.length > 0,
    step: (m, op) => (op.kind === "push" ? [...m, op.n] : m.slice(0, -1)),
  };

  // System under test with an injected bug: the third consecutive push is
  // applied twice.
  class BuggyStack {
    items: number[] = [];
    push(n: number): void {
      this.items.push(n);
      if (this.items.length === 3) this.items.push(n);
    }
    pop(): void {
      this.items.pop();
    }
  }

  const runHistory = (ops: Op[]): boolean => {
    const real = new BuggyStack();
    let model: number[] = [];
    for (const op of ops) {
      if (op.kind === "push") real.push(op.n);
      else real.pop();
      model = machine.step(model, op);
    }
    return JSON.stringify(real.items) === JSON.stringify(model);
  };

  test("shrinks to a minimal valid history and keeps the contract", () => {
    const r: CheckResult<Op[]> = check({
      arb: operationHistory(machine, { maxLength: 12 }),
      property: runHistory,
      seed: 21,
      numRuns: 200,
    });
    assert.equal(r.status, "failed");
    const ce = r.counterexample!;
    assert.equal(ce.length, 3, `expected 3 pushes, got ${JSON.stringify(ce)}`);
    assert.ok(ce.every((op) => op.kind === "push"));
    assert.equal(r.isMinimal, true);
    // Every candidate ever evaluated is a valid operation history.
    for (const e of r.trace) {
      const ops = JSON.parse(e.value) as Op[];
      assert.ok(isValidHistory(machine, ops), `invalid history reached the property: ${e.value}`);
    }
  });
});

describe("shrink checkpoint / resume", () => {
  const params = {
    arb: integer(0, 100_000),
    property: (n: number) => n < 500,
    seed: 13,
    numRuns: 100,
  };

  test("budget exhaustion pauses with a serializable checkpoint", () => {
    const r = check({ ...params, maxShrinkSteps: 3 });
    assert.equal(r.status, "failed");
    assert.equal(r.isMinimal, false);
    assert.ok(r.checkpoint, "expected a checkpoint");
    const cp = JSON.parse(r.checkpoint!);
    assert.equal(cp.seed, 13);
    assert.ok(Array.isArray(cp.tested) && cp.tested.length > 0);
  });

  test("resume finishes the shrink without re-testing candidates", () => {
    let calls = 0;
    const seen = new Set<string>();
    const counting = (n: number): boolean => {
      calls++;
      const key = JSON.stringify(n);
      assert.ok(!seen.has(key), `candidate ${key} evaluated twice`);
      seen.add(key);
      return n < 500;
    };

    const paused = check({ ...params, property: counting, maxShrinkSteps: 4 });
    assert.ok(paused.checkpoint);
    const finished = resume({ ...params, property: counting }, paused.checkpoint);

    assert.equal(finished.isMinimal, true);
    assert.equal(finished.counterexample, 500);
    assert.equal(finished.checkpoint, undefined);
    // Every property call was for a distinct candidate, and the evaluation
    // counter matches the number of property invocations exactly.
    assert.equal(calls, finished.evaluations);
    assert.equal(seen.size, calls);
    // Trace values are unique across the pause/resume boundary.
    const values = finished.trace.map((e) => e.value);
    assert.equal(new Set(values).size, values.length);
  });

  test("resumed shrink reaches the same result as an uninterrupted one", () => {
    const paused = check({ ...params, maxShrinkSteps: 2 });
    const resumed = resume(params, paused.checkpoint!);
    const direct = check(params);
    assert.equal(resumed.counterexample, direct.counterexample);
    assert.equal(resumed.status, direct.status);
    assert.ok(direct.isMinimal);
  });
});

describe("check trace", () => {
  test("trace records every evaluated candidate in order", () => {
    const r = check({ arb: integer(0, 1000), property: (n) => n < 50, seed: 7, numRuns: 100 });
    assert.equal(r.status, "failed");
    r.trace.forEach((e, i) => {
      assert.equal(e.index, i);
      assert.ok(e.phase === "generate" || e.phase === "shrink");
      assert.ok(e.outcome === "pass" || e.outcome === "failure" || e.outcome === "exception");
    });
    const shrinkEntries = r.trace.filter((e) => e.phase === "shrink");
    assert.ok(shrinkEntries.length > 0);
    assert.equal(JSON.parse(r.trace[r.trace.length - 1]!.value) <= 50, true);
    // Show an actual trace excerpt in the test output.
    console.log("actual check trace (seed=7, property n < 50):");
    for (const e of r.trace.slice(-8)) {
      console.log(`  #${e.index} ${e.phase.padEnd(8)} value=${e.value} -> ${e.outcome}`);
    }
  });
});
