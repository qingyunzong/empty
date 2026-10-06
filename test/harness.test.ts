import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  createReferenceQueue,
  createBrokenCancelQueue,
  differentialTest,
  firstDivergence,
  generateOps,
  hashOps,
  runOps,
  type Op,
} from "../src/index";

test("same implementation, same seed: no divergence and identical traces", async () => {
  const ops = generateOps(42, 30);
  const [traceA, traceB] = await Promise.all([
    runOps(createReferenceQueue, ops),
    runOps(createReferenceQueue, ops),
  ]);
  assert.equal(firstDivergence(traceA, traceB), null);
  assert.deepEqual(traceA, traceB);
});

test("scheduler controls promise settlement: no pump means pending", async () => {
  const ops: Op[] = [{ kind: "submit", id: "a" }];
  const trace = await runOps(createReferenceQueue, ops);
  const step = trace.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.results, "#0=pending");
  assert.equal(step.state, "a:queued");
});

test("unfinished is not failure: pending promises do not fail the comparison", async () => {
  const ops: Op[] = [
    { kind: "submit", id: "a" },
    { kind: "submit", id: "b" },
  ];
  const [traceA, traceB] = await Promise.all([
    runOps(createReferenceQueue, ops),
    runOps(createReferenceQueue, ops),
  ]);
  assert.equal(firstDivergence(traceA, traceB), null);
  const last = traceA.steps[traceA.steps.length - 1];
  assert.ok(last !== undefined);
  assert.ok(last.results.includes("pending"));
});

test("pumping settles promises in deterministic order", async () => {
  const ops: Op[] = [
    { kind: "submit", id: "a" },
    { kind: "submit", id: "b" },
    { kind: "pump", steps: 4 },
  ];
  const trace = await runOps(createReferenceQueue, ops);
  const last = trace.steps[trace.steps.length - 1];
  assert.ok(last !== undefined);
  assert.equal(last.results, "#0=resolved:a:done,#1=resolved:b:done");
  assert.equal(last.events, "submitted:a,submitted:b,started:a,started:b,finished:a,finished:b");
});

test("acceptance: deliberately broken cancel is detected, with hash-bound minimal prefix", async () => {
  // Find a seed whose generated sequence exercises cancel on a live job.
  let report = null;
  for (let seed = 1; seed < 200 && report === null; seed += 1) {
    const candidate = await differentialTest(createReferenceQueue, createBrokenCancelQueue, seed, 20);
    if (!candidate.ok) report = candidate;
  }
  assert.ok(report !== null, "expected to find a diverging seed");
  assert.ok(!report.ok);

  // Diff is bound to the source hash of the exact op sequence tested.
  const expectedHash = hashOps(generateOps(report.seed, 20));
  assert.equal(report.sourceHash, expectedHash);

  // Divergence is observed in canonical state (and possibly results/events).
  assert.ok(report.divergence.kinds.length > 0);
  assert.ok(report.divergence.index >= 0);

  // Minimal prefix still reproduces a divergence...
  const [minA, minB] = await Promise.all([
    runOps(createReferenceQueue, report.minimalPrefix),
    runOps(createBrokenCancelQueue, report.minimalPrefix),
  ]);
  assert.ok(firstDivergence(minA, minB) !== null);

  // ...is no longer than the original prefix...
  assert.ok(report.minimalPrefix.length <= report.divergence.index + 1);

  // ...and is reproducible: shrinking again yields the same hash.
  const again = await differentialTest(createReferenceQueue, createBrokenCancelQueue, report.seed, 20);
  assert.ok(!again.ok);
  if (!again.ok) {
    assert.equal(again.minimalHash, report.minimalHash);
    assert.equal(again.sourceHash, report.sourceHash);
  }
});

test("reference vs reference over generated ops: always ok", async () => {
  for (const seed of [1, 7, 99, 12345]) {
    const report = await differentialTest(createReferenceQueue, createReferenceQueue, seed, 25);
    assert.ok(report.ok, `seed ${seed} should not diverge`);
  }
});
