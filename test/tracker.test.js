import { test } from "node:test";
import assert from "node:assert/strict";
import { Tracker } from "../src/tracker.js";

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

function plan(flightId, overrides = {}) {
  return {
    type: "FLIGHT_PLAN",
    flightId,
    start: 0,
    end: 100,
    polygon: SQUARE,
    version: 1,
    ...overrides,
  };
}

function obs(obsId, overrides = {}) {
  return { type: "GROUND_OBSERVATION", obsId, ts: 10, x: 5, y: 5, ...overrides };
}

test("observation inside a plan window and polygon matches with certificate", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("alpha"));
  const emitted = tracker.processEvent(obs("o1"));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].action, "MATCH");
  assert.equal(emitted[0].flightId, "alpha");
  assert.equal(emitted[0].certificate.classification, "INSIDE");
  assert.equal(emitted[0].certificate.rule, "even-odd");
  assert.equal(emitted[0].certificate.version, 1);
});

test("acceptance: late-arriving plan matches a previously unmatched observation", () => {
  const tracker = new Tracker();
  // Observation arrives first, no plan known -> buffered, nothing emitted.
  const atArrival = tracker.processEvent(obs("o1"));
  assert.deepEqual(atArrival, []);
  // Plan arrives late but before the watermark publishes the observation.
  const atPlan = tracker.processEvent(plan("alpha"));
  assert.equal(atPlan.length, 1);
  assert.equal(atPlan[0].action, "MATCH");
  assert.equal(atPlan[0].obsId, "o1");
  assert.equal(atPlan[0].flightId, "alpha");
  // Watermark publication must not emit UNMATCHED afterwards.
  const atWatermark = tracker.processEvent({ type: "WATERMARK", ts: 15 });
  assert.deepEqual(atWatermark, []);
});

test("acceptance: polygon shrink un-matches a boundary observation and cascades WITHDRAW", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("alpha"));
  // (5, 0) lies exactly on the square's bottom edge -> counts as inside.
  const atObs = tracker.processEvent(obs("o1", { x: 5, y: 0 }));
  assert.equal(atObs[0].action, "MATCH");
  assert.equal(atObs[0].certificate.classification, "EDGE");

  const shrunk = [
    [2, 2],
    [8, 2],
    [8, 8],
    [2, 8],
  ];
  const atCorrection = tracker.processEvent(
    plan("alpha", { version: 2, polygon: shrunk }),
  );
  assert.equal(atCorrection.length, 1);
  assert.equal(atCorrection[0].action, "WITHDRAW");
  assert.equal(atCorrection[0].obsId, "o1");
  assert.equal(atCorrection[0].flightId, "alpha");
  assert.equal(atCorrection[0].reason, "PLAN_CORRECTED");

  // The observation is now unmatched and is published as such at the watermark.
  const atWatermark = tracker.processEvent({ type: "WATERMARK", ts: 15 });
  assert.deepEqual(atWatermark, [{ action: "UNMATCHED", obsId: "o1" }]);
});

test("acceptance: overlapping plans select the lexicographically smallest flightId", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("zeta"));
  tracker.processEvent(plan("beta"));
  tracker.processEvent(plan("alpha"));
  const emitted = tracker.processEvent(obs("o1"));
  assert.equal(emitted[0].action, "MATCH");
  assert.equal(emitted[0].flightId, "alpha");
});

test("lexicographic choice is stable when a smaller-id plan arrives later", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("beta"));
  tracker.processEvent(obs("o1"));
  const emitted = tracker.processEvent(plan("alpha"));
  assert.equal(emitted.length, 2);
  assert.deepEqual(
    emitted.map((a) => [a.action, a.flightId]),
    [
      ["WITHDRAW", "beta"],
      ["MATCH", "alpha"],
    ],
  );
});

test("observation outside the time window does not match", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("alpha", { start: 20, end: 30 }));
  assert.deepEqual(tracker.processEvent(obs("o1", { ts: 10 })), []);
  assert.deepEqual(tracker.processEvent(obs("o2", { ts: 30 })), []);
  const emitted = tracker.processEvent(obs("o3", { ts: 20 }));
  assert.equal(emitted[0].action, "MATCH");
});

test("unmatched observation is published as UNMATCHED at watermark > ts + 5", () => {
  const tracker = new Tracker();
  tracker.processEvent(obs("o1"));
  assert.deepEqual(tracker.processEvent({ type: "WATERMARK", ts: 14 }), []);
  const emitted = tracker.processEvent({ type: "WATERMARK", ts: 15 });
  assert.deepEqual(emitted, [{ action: "UNMATCHED", obsId: "o1" }]);
});

test("retracting a plan cascades WITHDRAW and re-matches to the next plan", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("alpha"));
  tracker.processEvent(plan("beta"));
  tracker.processEvent(obs("o1"));
  const emitted = tracker.processEvent({ type: "RETRACT", flightId: "alpha" });
  assert.deepEqual(
    emitted.map((a) => [a.action, a.flightId, a.reason]),
    [
      ["WITHDRAW", "alpha", "PLAN_RETRACTED"],
      ["MATCH", "beta", undefined],
    ],
  );
});

test("retracting the only matching plan leaves the observation unmatched", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("alpha"));
  tracker.processEvent(obs("o1"));
  const emitted = tracker.processEvent({ type: "RETRACT", flightId: "alpha" });
  assert.deepEqual(emitted, [
    { action: "WITHDRAW", obsId: "o1", flightId: "alpha", reason: "PLAN_RETRACTED" },
  ]);
  const atWatermark = tracker.processEvent({ type: "WATERMARK", ts: 15 });
  assert.deepEqual(atWatermark, [{ action: "UNMATCHED", obsId: "o1" }]);
});

test("modification after publication is rejected with LATE", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("alpha"));
  tracker.processEvent(obs("o1"));
  tracker.processEvent({ type: "WATERMARK", ts: 15 });
  const correction = tracker.processEvent(
    plan("alpha", { version: 2, polygon: [[2, 2], [8, 2], [8, 8], [2, 8]] }),
  );
  assert.equal(correction.length, 1);
  assert.equal(correction[0].action, "ERROR");
  assert.equal(correction[0].error, "LATE");
  const retract = tracker.processEvent({ type: "RETRACT", flightId: "alpha" });
  assert.equal(retract[0].error, "LATE");
});

test("lower or equal version is rejected with STALE_VERSION", () => {
  const tracker = new Tracker();
  tracker.processEvent(plan("alpha", { version: 2 }));
  const lower = tracker.processEvent(plan("alpha", { version: 1 }));
  assert.equal(lower[0].error, "STALE_VERSION");
  assert.equal(lower[0].currentVersion, 2);
  const equal = tracker.processEvent(plan("alpha", { version: 2 }));
  assert.equal(equal[0].error, "STALE_VERSION");
});

test("polygon with fewer than 3 vertices is INVALID_POLYGON", () => {
  const tracker = new Tracker();
  const emitted = tracker.processEvent(
    plan("alpha", { polygon: [[0, 0], [1, 1]] }),
  );
  assert.equal(emitted[0].action, "ERROR");
  assert.equal(emitted[0].error, "INVALID_POLYGON");
});

test("non-numeric coordinates are MALFORMED", () => {
  const tracker = new Tracker();
  const badPlan = tracker.processEvent(
    plan("alpha", { polygon: [[0, 0], [10, "x"], [5, 10]] }),
  );
  assert.equal(badPlan[0].error, "MALFORMED");
  const badObs = tracker.processEvent(obs("o1", { x: "5" }));
  assert.equal(badObs[0].error, "MALFORMED");
});

test("retracting an unknown flightId is UNKNOWN_RETRACT", () => {
  const tracker = new Tracker();
  const emitted = tracker.processEvent({ type: "RETRACT", flightId: "ghost" });
  assert.equal(emitted[0].action, "ERROR");
  assert.equal(emitted[0].error, "UNKNOWN_RETRACT");
});

test("out-of-order observations before the watermark all get matched", () => {
  const tracker = new Tracker();
  tracker.processEvent(obs("o2", { ts: 12 }));
  tracker.processEvent(obs("o1", { ts: 10 }));
  tracker.processEvent(plan("alpha"));
  const matched = tracker.actions.filter((a) => a.action === "MATCH");
  assert.deepEqual(
    matched.map((a) => a.obsId).sort(),
    ["o1", "o2"],
  );
});
