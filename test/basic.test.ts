import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMarket } from "../src/market.js";
import { createSession } from "../src/session.js";
import { certify } from "../src/stability.js";
import type { MarketInput } from "../src/types.js";

describe("classical stable matching", () => {
  const classic: MarketInput = {
    applicants: [
      { id: "a1", prefers: [["X"], ["Y"], ["Z"]] },
      { id: "a2", prefers: [["Y"], ["X"], ["Z"]] },
      { id: "a3", prefers: [["X"], ["Y"], ["Z"]] },
    ],
    institutions: [
      { id: "X", capacity: 1, prefers: [["a2"], ["a1"], ["a3"]] },
      { id: "Y", capacity: 1, prefers: [["a1"], ["a2"], ["a3"]] },
      { id: "Z", capacity: 1, prefers: [["a1"], ["a2"], ["a3"]] },
    ],
  };

  it("computes the applicant-optimal stable matching with a certificate", () => {
    const result = createSession(classic).solve({ enumerate: true });
    assert.deepEqual(result.matching, { a1: "X", a2: "Y", a3: "Z" });
    assert.ok(result.certificate.feasible);
    assert.ok(result.certificate.stable);
    assert.equal(result.certificate.blockingPairs.length, 0);
    assert.ok(result.certificate.checks.length > 0);
    for (const check of result.certificate.checks) {
      assert.equal(check.blocking, null);
      assert.ok(check.replacementSetsExamined > 0);
    }
    assert.ok(result.enumeration !== undefined);
    assert.ok(result.enumeration.algorithmMatchingInStableSet);
    assert.ok(result.enumeration.stableMatchings.length >= 1);
  });

  it("respects institution capacities", () => {
    const market: MarketInput = {
      applicants: [
        { id: "a1", prefers: [["X"], ["Y"]] },
        { id: "a2", prefers: [["X"], ["Y"]] },
        { id: "a3", prefers: [["X"], ["Y"]] },
        { id: "a4", prefers: [["Y"], ["X"]] },
      ],
      institutions: [
        { id: "X", capacity: 2, prefers: [["a1"], ["a2"], ["a3"], ["a4"]] },
        { id: "Y", capacity: 1, prefers: [["a4"], ["a3"], ["a2"], ["a1"]] },
      ],
    };
    const result = createSession(market).solve({ enumerate: true });
    assert.deepEqual(result.matching, { a1: "X", a2: "X", a4: "Y" });
    assert.deepEqual(result.certificate.unassigned, ["a3"]);
    assert.ok(result.certificate.stable);
    assert.ok(result.enumeration?.algorithmMatchingInStableSet);
  });
});

describe("tie-breaking by id", () => {
  it("breaks institution-side ties by applicant id", () => {
    const market: MarketInput = {
      applicants: [
        { id: "a1", prefers: [["X"]] },
        { id: "a2", prefers: [["X"]] },
      ],
      institutions: [{ id: "X", capacity: 1, prefers: [["a2", "a1"]] }],
    };
    const result = createSession(market).solve();
    assert.deepEqual(result.matching, { a1: "X" });
    assert.ok(result.certificate.stable);
  });

  it("breaks applicant-side ties by institution id", () => {
    const market: MarketInput = {
      applicants: [{ id: "a1", prefers: [["i2", "i1"]] }],
      institutions: [
        { id: "i1", capacity: 1, prefers: [["a1"]] },
        { id: "i2", capacity: 1, prefers: [["a1"]] },
      ],
    };
    const result = createSession(market).solve();
    assert.deepEqual(result.matching, { a1: "i1" });
  });
});

describe("unacceptable pairs", () => {
  const market: MarketInput = {
    applicants: [
      { id: "a1", prefers: [["X"], ["Y"]] },
      { id: "a2", prefers: [["Y"]] },
    ],
    institutions: [
      { id: "X", capacity: 1, prefers: [["a1"]] },
      { id: "Y", capacity: 1, prefers: [["a2"]] },
    ],
  };

  it("never matches an unlisted pair", () => {
    const result = createSession(market).solve({ enumerate: true });
    assert.deepEqual(result.matching, { a1: "X", a2: "Y" });
    assert.ok(result.certificate.stable);
  });

  it("flags a manually forced unacceptable pair as infeasible", () => {
    const compiled = buildMarket(market);
    const forced = new Map([["a1", "Y"]]);
    const certificate = certify(compiled, forced);
    assert.equal(certificate.feasible, false);
    assert.equal(certificate.stable, false);
  });

  it("treats applicants with empty preference lists as unassigned", () => {
    const empty: MarketInput = {
      applicants: [{ id: "a1", prefers: [] }],
      institutions: [{ id: "X", capacity: 1, prefers: [["a1"]] }],
    };
    const result = createSession(empty).solve();
    assert.deepEqual(result.matching, {});
    assert.deepEqual(result.certificate.unassigned, ["a1"]);
    assert.ok(result.certificate.stable);
  });
});
