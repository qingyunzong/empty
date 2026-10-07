import { describe, it } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import {
  createTransitionTable,
  localToUtc,
  utcToLocal,
  verifyRoundTrip,
} from "../src/index.js";

describe("table validation", () => {
  it("rejects non-integer seconds", () => {
    throws(() => createTransitionTable(0.5, []));
    throws(() => createTransitionTable(0, [{ atUtc: 1.5, offsetSeconds: 0 }]));
    throws(() => createTransitionTable(0, [{ atUtc: 1, offsetSeconds: Number.NaN }]));
  });

  it("rejects unsorted transitions", () => {
    throws(() =>
      createTransitionTable(0, [
        { atUtc: 100, offsetSeconds: 1 },
        { atUtc: 100, offsetSeconds: 2 },
      ]),
    );
    throws(() =>
      createTransitionTable(0, [
        { atUtc: 200, offsetSeconds: 1 },
        { atUtc: 100, offsetSeconds: 2 },
      ]),
    );
  });

  it("freezes the table deeply", () => {
    const table = createTransitionTable(0, [{ atUtc: 10, offsetSeconds: 5 }]);
    equal(Object.isFrozen(table), true);
    equal(Object.isFrozen(table.transitions), true);
    equal(Object.isFrozen(table.transitions[0]), true);
  });
});

describe("fixed offset (no transitions)", () => {
  const table = createTransitionTable(3600, []);

  it("maps forward and back uniquely", () => {
    deepEqual(utcToLocal(table, 100), {
      utc: 100,
      local: 3700,
      offsetSeconds: 3600,
      ruleIndex: 0,
    });
    const back = localToUtc(table, 3700);
    equal(back.kind, "unique");
    deepEqual(back.candidates, [{ utc: 100, offsetSeconds: 3600, ruleIndex: 0 }]);
  });
});

describe("gap (offset jumps forward)", () => {
  // offset 0 -> 3600 at utc 1000: local seconds [1000, 4600) never occur.
  const table = createTransitionTable(0, [{ atUtc: 1000, offsetSeconds: 3600 }]);

  it("reports an explicit no-solution inside the gap", () => {
    const res = localToUtc(table, 2000);
    equal(res.kind, "none");
    deepEqual(res.candidates, []);
  });

  it("maps gap edges half-open", () => {
    equal(localToUtc(table, 999).kind, "unique"); // last valid local before gap
    equal(localToUtc(table, 1000).kind, "none"); // first missing local
    equal(localToUtc(table, 4599).kind, "none"); // last missing local
    const first = localToUtc(table, 4600); // first valid local after gap
    equal(first.kind, "unique");
    equal(first.candidates[0]!.utc, 1000);
  });
});

describe("overlap (offset jumps back)", () => {
  // offset 3600 -> 0 at utc 1000: local seconds [1000, 4600) occur twice.
  const table = createTransitionTable(3600, [{ atUtc: 1000, offsetSeconds: 0 }]);

  it("returns two candidates inside the overlap", () => {
    const res = localToUtc(table, 2000);
    equal(res.kind, "ambiguous");
    deepEqual(
      res.candidates.map((c) => c.utc),
      [-1600, 2000],
    );
    deepEqual(
      res.candidates.map((c) => c.ruleIndex),
      [0, 1],
    );
  });

  it("is unique outside the overlap", () => {
    equal(localToUtc(table, 999).kind, "unique");
    equal(localToUtc(table, 4600).kind, "unique");
    const last = localToUtc(table, 4599);
    equal(last.kind, "ambiguous");
    deepEqual(
      last.candidates.map((c) => c.utc),
      [999, 4599],
    );
  });
});

describe("multiple consecutive transitions", () => {
  // DST-like: 0 -> 3600 at utc 1000, 3600 -> 0 at utc 10000.
  const dst = createTransitionTable(0, [
    { atUtc: 1000, offsetSeconds: 3600 },
    { atUtc: 10000, offsetSeconds: 0 },
  ]);

  it("handles gap and overlap around both transitions", () => {
    equal(localToUtc(dst, 2000).kind, "none"); // spring gap [1000, 4600)
    const fall = localToUtc(dst, 12000); // fall overlap [10000, 13600)
    equal(fall.kind, "ambiguous");
    deepEqual(
      fall.candidates.map((c) => c.utc),
      [8400, 12000],
    );
  });

  it("exhaustively verifies forward mapping by reverse lookup", () => {
    const report = verifyRoundTrip(dst, -20000, 20000);
    equal(report.checked, 40000);
    deepEqual(report.failures, []);
  });

  it("supports three candidates for exotic rapid transitions", () => {
    // offset 10 -> 5 at utc 0, 5 -> 0 at utc 3: local 6 has three preimages.
    const exotic = createTransitionTable(10, [
      { atUtc: 0, offsetSeconds: 5 },
      { atUtc: 3, offsetSeconds: 0 },
    ]);
    const res = localToUtc(exotic, 6);
    equal(res.kind, "ambiguous");
    deepEqual(
      res.candidates.map((c) => c.utc),
      [-4, 1, 6],
    );
    const report = verifyRoundTrip(exotic, -1000, 1000);
    deepEqual(report.failures, []);
  });
});
