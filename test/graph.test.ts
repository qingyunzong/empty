import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSteps,
  CancelledError,
  CompensationError,
  GraphValidationError,
  type StepDefinition,
} from "../src/graph.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("executes steps in deterministic dependency order", async () => {
  const started: string[] = [];
  const step = (name: string, dependsOn?: string[]): StepDefinition => ({
    name,
    ...(dependsOn ? { dependsOn } : {}),
    execute: () => {
      started.push(name);
      return name;
    },
  });
  // Definition order deliberately shuffled relative to the DAG.
  const result = await runSteps([
    step("d", ["b", "c"]),
    step("c", ["a"]),
    step("a"),
    step("b", ["a"]),
  ]);
  // Deterministic: dependencies first, ties broken by definition order
  // (definition order here is d, c, a, b).
  assert.deepEqual(started, ["a", "c", "b", "d"]);
  assert.deepEqual([...result.outputs.keys()], ["a", "c", "b", "d"]);
  assert.equal(result.outputs.get("d"), "d");
});

test("a dependent step never starts before its dependency resolves (controlled promise)", async () => {
  const gate = deferred<string>();
  const started: string[] = [];
  const run = runSteps([
    {
      name: "a",
      execute: () => {
        started.push("a");
        return gate.promise;
      },
    },
    {
      name: "b",
      dependsOn: ["a"],
      execute: () => {
        started.push("b");
        return "b";
      },
    },
  ]);
  await tick();
  assert.deepEqual(started, ["a"]); // b is gated behind a's promise
  gate.resolve("a-out");
  const result = await run;
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(result.outputs.get("a"), "a-out");
});

test("on failure, compensates only succeeded compensable steps, in reverse dependency order", async () => {
  const compensated: string[] = [];
  const boom = new Error("step c exploded");
  const steps: StepDefinition[] = [
    {
      name: "a",
      execute: () => "a",
      compensate: () => {
        compensated.push("a");
      },
    },
    {
      name: "b",
      dependsOn: ["a"],
      execute: () => "b",
      compensate: () => {
        compensated.push("b");
      },
    },
    {
      name: "no-comp",
      dependsOn: ["b"],
      execute: () => "nc",
      // succeeded but NOT compensable -> must be skipped
    },
    {
      name: "c",
      dependsOn: ["no-comp"],
      execute: () => {
        throw boom;
      },
      compensate: () => {
        compensated.push("c"); // failed step -> must NOT be compensated
      },
    },
    {
      name: "never-ran",
      dependsOn: ["c"],
      execute: () => "x",
      compensate: () => {
        compensated.push("never-ran");
      },
    },
  ];
  const err = await runSteps(steps).then(
    () => assert.fail("should have rejected"),
    (e: unknown) => e,
  );
  assert.equal(err, boom, "clean rollback rethrows the original failure");
  assert.deepEqual(compensated, ["b", "a"]);
});

test("compensation failures are aggregated, never reported as rollback success", async () => {
  const original = new Error("original failure");
  const compBoom = new Error("compensation of b failed");
  const compensated: string[] = [];
  const steps: StepDefinition[] = [
    {
      name: "a",
      execute: () => "a",
      compensate: () => {
        compensated.push("a");
      },
    },
    {
      name: "b",
      dependsOn: ["a"],
      execute: () => "b",
      compensate: () => {
        compensated.push("b");
        throw compBoom;
      },
    },
    {
      name: "c",
      dependsOn: ["b"],
      execute: () => {
        throw original;
      },
    },
  ];
  const err = await runSteps(steps).then(
    () => assert.fail("should have rejected"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof CompensationError);
  assert.ok(err instanceof AggregateError);
  const agg = err as CompensationError;
  assert.equal(agg.cause, original, "original failure preserved as cause");
  assert.deepEqual(agg.errors, [compBoom]);
  assert.equal(agg.failures.length, 1);
  assert.equal(agg.failures[0]!.step, "b");
  assert.equal(agg.failures[0]!.error, compBoom);
  // Compensation continued past the failure: a was still rolled back.
  assert.deepEqual(compensated, ["b", "a"]);
});

test("cancellation triggers the same compensation rules", async () => {
  const controller = new AbortController();
  const gate = deferred<string>();
  const compensated: string[] = [];
  const executed: string[] = [];
  const steps: StepDefinition[] = [
    {
      name: "a",
      execute: () => {
        executed.push("a");
        return "a";
      },
      compensate: () => {
        compensated.push("a");
      },
    },
    {
      name: "b",
      dependsOn: ["a"],
      execute: () => {
        executed.push("b");
        return gate.promise; // in-flight when cancellation lands
      },
      compensate: () => {
        compensated.push("b");
      },
    },
    {
      name: "c",
      dependsOn: ["b"],
      execute: () => {
        executed.push("c");
        return "c";
      },
      compensate: () => {
        compensated.push("c");
      },
    },
  ];
  const run = runSteps(steps, { signal: controller.signal });
  await tick();
  assert.deepEqual(executed, ["a", "b"]);
  controller.abort();
  gate.resolve("b-out"); // b settles successfully after abort
  const err = await run.then(
    () => assert.fail("should have rejected"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof CancelledError);
  assert.deepEqual(executed, ["a", "b"], "c never started after cancel");
  // b succeeded (settled before the abort check) so it is compensated too.
  assert.deepEqual(compensated, ["b", "a"]);
});

test("cancellation + compensation failure aggregates with CancelledError as cause", async () => {
  const controller = new AbortController();
  const compBoom = new Error("compensation failed during cancel");
  const gate = deferred<string>();
  const steps: StepDefinition[] = [
    {
      name: "a",
      execute: () => "a",
      compensate: () => {
        throw compBoom;
      },
    },
    {
      name: "b",
      dependsOn: ["a"],
      execute: () => gate.promise, // in-flight when cancellation lands
    },
  ];
  const run = runSteps(steps, { signal: controller.signal });
  await tick(); // a done, b in-flight
  controller.abort();
  gate.resolve("b");
  const err = await run.then(
    () => assert.fail("should have rejected"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof CompensationError);
  const agg = err as CompensationError;
  assert.ok(agg.cause instanceof CancelledError);
  assert.deepEqual(agg.errors, [compBoom]);
  assert.equal(agg.failures[0]!.step, "a");
});

test("each execute and compensate runs at most once", async () => {
  const counts = { execA: 0, execB: 0, compA: 0, compB: 0 };
  const steps: StepDefinition[] = [
    {
      name: "a",
      execute: () => {
        counts.execA += 1;
        return "a";
      },
      compensate: () => {
        counts.compA += 1;
      },
    },
    {
      name: "b",
      dependsOn: ["a"],
      execute: () => {
        counts.execB += 1;
        return "b";
      },
      compensate: () => {
        counts.compB += 1;
        throw new Error("compensation boom"); // must not be retried
      },
    },
    {
      name: "c",
      dependsOn: ["b"],
      execute: () => {
        throw new Error("trigger rollback");
      },
    },
  ];
  await assert.rejects(runSteps(steps), CompensationError);
  assert.deepEqual(counts, { execA: 1, execB: 1, compA: 1, compB: 1 });
});

test("compensation receives the step's own output", async () => {
  const received: unknown[] = [];
  const steps: StepDefinition[] = [
    {
      name: "a",
      execute: () => ({ id: 42 }),
      compensate: (output) => {
        received.push(output);
      },
    },
    {
      name: "b",
      dependsOn: ["a"],
      execute: () => {
        throw new Error("boom");
      },
    },
  ];
  await assert.rejects(runSteps(steps), /boom/);
  assert.deepEqual(received, [{ id: 42 }]);
});

test("invalid graphs are rejected before anything executes", async () => {
  let executed = 0;
  const exec = () => {
    executed += 1;
    return 1;
  };
  await assert.rejects(
    runSteps([
      { name: "a", dependsOn: ["b"], execute: exec },
      { name: "b", dependsOn: ["a"], execute: exec },
    ]),
    GraphValidationError,
  );
  await assert.rejects(
    runSteps([{ name: "a", dependsOn: ["ghost"], execute: exec }]),
    GraphValidationError,
  );
  await assert.rejects(
    runSteps([
      { name: "a", execute: exec },
      { name: "a", execute: exec },
    ]),
    GraphValidationError,
  );
  assert.equal(executed, 0);
});
