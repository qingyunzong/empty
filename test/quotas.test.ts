import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMarket } from "../src/market.js";
import { createSession } from "../src/session.js";
import { certify } from "../src/stability.js";
import type { MarketInput } from "../src/types.js";

describe("nested category quotas", () => {
  const market: MarketInput = {
    applicants: [
      { id: "a1", categories: ["phy"], prefers: [["X"]] },
      { id: "a2", categories: ["phy"], prefers: [["X"]] },
      { id: "a3", categories: ["sci"], prefers: [["X"]] },
      { id: "a4", categories: ["art"], prefers: [["X"]] },
      { id: "a5", categories: [], prefers: [["X"]] },
    ],
    institutions: [
      {
        id: "X",
        capacity: 3,
        quotas: [
          { id: "sci", quota: 2, children: [{ id: "phy", quota: 1 }] },
          { id: "art", quota: 2 },
        ],
        prefers: [["a1"], ["a2"], ["a3"], ["a4"], ["a5"]],
      },
    ],
  };

  it("enforces leaf and ancestor quotas jointly", () => {
    const result = createSession(market).solve({ enumerate: true });
    assert.deepEqual(result.matching, { a1: "X", a3: "X", a4: "X" });
    assert.deepEqual(result.certificate.admits["X"], ["a1", "a3", "a4"]);
    assert.ok(result.certificate.stable);
    assert.ok(result.enumeration?.algorithmMatchingInStableSet);
  });

  it("counts multi-category applicants toward every matching branch", () => {
    const multi: MarketInput = {
      applicants: [
        { id: "a1", categories: ["sci", "art"], prefers: [["X"]] },
        { id: "a2", categories: ["sci"], prefers: [["X"]] },
        { id: "a3", categories: ["art"], prefers: [["X"]] },
      ],
      institutions: [
        {
          id: "X",
          capacity: 2,
          quotas: [
            { id: "sci", quota: 1 },
            { id: "art", quota: 1 },
          ],
          prefers: [["a1"], ["a2"], ["a3"]],
        },
      ],
    };
    const result = createSession(multi).solve();
    assert.deepEqual(result.matching, { a1: "X" });
    assert.ok(result.certificate.stable);
  });
});

describe("explicit replacement rule", () => {
  it("reports a blocking pair that evicts a worse admit when full", () => {
    const market: MarketInput = {
      applicants: [
        { id: "a1", prefers: [["X"]] },
        { id: "a2", prefers: [["X"]] },
      ],
      institutions: [{ id: "X", capacity: 1, prefers: [["a2"], ["a1"]] }],
    };
    const compiled = buildMarket(market);
    const certificate = certify(compiled, new Map([["a1", "X"]]));
    assert.equal(certificate.stable, false);
    assert.equal(certificate.blockingPairs.length, 1);
    const witness = certificate.blockingPairs[0];
    assert.ok(witness !== undefined);
    assert.equal(witness.applicant, "a2");
    assert.deepEqual(witness.replaced, ["a1"]);
    assert.deepEqual(witness.resultingAdmits, ["a2"]);
  });

  it("reports a blocking pair that fills an empty seat with no rejection", () => {
    const market: MarketInput = {
      applicants: [
        { id: "a1", prefers: [["X"]] },
        { id: "a2", prefers: [["X"]] },
      ],
      institutions: [{ id: "X", capacity: 2, prefers: [["a1"], ["a2"]] }],
    };
    const compiled = buildMarket(market);
    const certificate = certify(compiled, new Map([["a2", "X"]]));
    assert.equal(certificate.stable, false);
    const witness = certificate.blockingPairs[0];
    assert.ok(witness !== undefined);
    assert.equal(witness.applicant, "a1");
    assert.deepEqual(witness.replaced, []);
    assert.deepEqual(witness.resultingAdmits, ["a1", "a2"]);
  });

  it("rejects value-losing multi-evictions even when quotas allow them", () => {
    const market: MarketInput = {
      applicants: [
        { id: "a1", categories: ["c1"], prefers: [["X"]] },
        { id: "a2", categories: ["c2"], prefers: [["X"]] },
        { id: "a3", categories: ["c1", "c2"], prefers: [["X"]] },
      ],
      institutions: [
        {
          id: "X",
          capacity: 2,
          quotas: [
            { id: "c1", quota: 1 },
            { id: "c2", quota: 1 },
          ],
          prefers: [["a1"], ["a2"], ["a3"]],
        },
      ],
    };
    const compiled = buildMarket(market);
    const certificate = certify(compiled, new Map([["a1", "X"], ["a2", "X"]]));
    assert.ok(certificate.feasible);
    assert.ok(certificate.stable);
    const check = certificate.checks.find((c) => c.applicant === "a3" && c.institution === "X");
    assert.ok(check !== undefined);
    assert.equal(check.blocking, null);
    assert.equal(check.replacementSetsExamined, 4);
  });

  it("allows a star applicant to replace two weak admits when quotas force it", () => {
    const market: MarketInput = {
      applicants: [
        { id: "a1", categories: ["c1"], prefers: [["X"]] },
        { id: "a2", categories: ["c2"], prefers: [["X"]] },
        { id: "a3", categories: ["c1", "c2"], prefers: [["X"]] },
        { id: "a4", categories: [], prefers: [["X"]] },
        { id: "a5", categories: [], prefers: [["X"]] },
      ],
      institutions: [
        {
          id: "X",
          capacity: 2,
          quotas: [
            { id: "c1", quota: 1 },
            { id: "c2", quota: 1 },
          ],
          prefers: [["a3"], ["a4"], ["a5"], ["a1"], ["a2"]],
        },
      ],
    };
    const compiled = buildMarket(market);
    const certificate = certify(compiled, new Map([["a1", "X"], ["a2", "X"]]));
    assert.equal(certificate.stable, false);
    const witness = certificate.blockingPairs[0];
    assert.ok(witness !== undefined);
    assert.equal(witness.applicant, "a3");
    assert.deepEqual(witness.replaced, ["a1", "a2"]);
    assert.deepEqual(witness.resultingAdmits, ["a3"]);
  });
});
