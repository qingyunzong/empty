import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryPlan,
  certificateDigest,
  compareIds,
  DeliveryError,
  type EventSpec,
} from "../src/engine.js";

test("candidate requires all deps satisfied; priority then id among ready", () => {
  const events: EventSpec[] = [
    { id: "a", priority: 1 },
    { id: "b", priority: 5 },
    { id: "c", priority: 9, deps: ["a", "b"] },
    { id: "d", priority: 9 },
  ];
  const plan = buildDeliveryPlan(events);
  // c has highest priority but is not a candidate until a and b are delivered.
  assert.deepEqual(plan.order, ["d", "b", "a", "c"]);
  assert.equal(plan.certificates.length, 4);
  assert.deepEqual(plan.certificates[3]?.satisfiedDeps, ["a", "b"]);
});

test("high priority cannot jump causality chains", () => {
  const events: EventSpec[] = [
    { id: "low", priority: 0 },
    { id: "mid", priority: 50, deps: ["low"] },
    { id: "high", priority: 100, deps: ["mid"] },
  ];
  const plan = buildDeliveryPlan(events);
  assert.deepEqual(plan.order, ["low", "mid", "high"]);
});

test("tie on priority falls back to smaller id (numeric aware)", () => {
  const events: EventSpec[] = [
    { id: "10", priority: 3 },
    { id: "9", priority: 3 },
    { id: "2", priority: 3 },
  ];
  const plan = buildDeliveryPlan(events);
  assert.deepEqual(plan.order, ["2", "9", "10"]);
  assert.ok(compareIds("9", "10") < 0);
  assert.ok(compareIds("a", "b") < 0);
});

test("cancel blocks transitive successors but keeps metadata", () => {
  const events: EventSpec[] = [
    { id: "root", priority: 1, meta: { owner: "ops", note: "keep me" } },
    { id: "child", priority: 2, deps: ["root"], meta: { lane: "x" } },
    { id: "grand", priority: 3, deps: ["child"] },
    { id: "free", priority: 0 },
  ];
  const plan = buildDeliveryPlan(events, ["root"]);
  assert.deepEqual(plan.order, ["free"]);
  assert.deepEqual(plan.blocked, ["child", "grand"]);
  assert.deepEqual(plan.cancelled, [
    { eventId: "root", priority: 1, deps: [], meta: { owner: "ops", note: "keep me" } },
  ]);
  const grandChain = plan.blockingChains.find((c) => c.eventId === "grand");
  assert.deepEqual(grandChain?.chain, ["grand", "child", "root"]);
  assert.equal(grandChain?.rootCancelledId, "root");
  const childChain = plan.blockingChains.find((c) => c.eventId === "child");
  assert.deepEqual(childChain?.chain, ["child", "root"]);
});

test("cancelled events are never delivered nor listed as blocked", () => {
  const events: EventSpec[] = [
    { id: "x", priority: 1 },
    { id: "y", priority: 1, deps: ["x"] },
  ];
  const plan = buildDeliveryPlan(events, ["x"]);
  assert.deepEqual(plan.order, []);
  assert.deepEqual(plan.blocked, ["y"]);
  assert.deepEqual(plan.cancelled.map((c) => c.eventId), ["x"]);
});

test("certificate digest is deterministic and meta-sensitive", () => {
  const events: EventSpec[] = [{ id: "a", priority: 1, meta: { k: 1 } }];
  const p1 = buildDeliveryPlan(events);
  const p2 = buildDeliveryPlan(events);
  assert.equal(p1.certificates[0]?.digest, p2.certificates[0]?.digest);
  assert.match(p1.certificates[0]?.digest ?? "", /^[0-9a-f]{64}$/);
  const p3 = buildDeliveryPlan([{ id: "a", priority: 1, meta: { k: 2 } }]);
  assert.notEqual(p1.certificates[0]?.digest, p3.certificates[0]?.digest);
  const core = p1.certificates[0];
  if (core) {
    const { digest, ...rest } = core;
    assert.equal(certificateDigest(rest), digest);
  }
});

test("rejects cycles, unknown deps, duplicates, unknown cancellations", () => {
  assert.throws(
    () => buildDeliveryPlan([
      { id: "a", priority: 1, deps: ["b"] },
      { id: "b", priority: 1, deps: ["a"] },
    ]),
    (e) => e instanceof DeliveryError && /cycle/.test((e as Error).message),
  );
  assert.throws(
    () => buildDeliveryPlan([{ id: "a", priority: 1, deps: ["ghost"] }]),
    /unknown event ghost/,
  );
  assert.throws(
    () => buildDeliveryPlan([
      { id: "a", priority: 1 },
      { id: "a", priority: 2 },
    ]),
    /duplicate event id: a/,
  );
  assert.throws(
    () => buildDeliveryPlan([{ id: "a", priority: 1 }], ["nope"]),
    /cancelled id not found: nope/,
  );
  assert.throws(
    () => buildDeliveryPlan([{ id: "a", priority: 1, deps: ["a"] }]),
    /depends on itself/,
  );
});

test("empty input yields an empty plan", () => {
  const plan = buildDeliveryPlan([]);
  assert.deepEqual(plan.order, []);
  assert.deepEqual(plan.certificates, []);
  assert.deepEqual(plan.blockingChains, []);
});
