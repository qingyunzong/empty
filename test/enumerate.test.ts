import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMarket } from "../src/market.js";
import { createSession } from "../src/session.js";
import { certify } from "../src/stability.js";
import type { MarketInput } from "../src/types.js";
import { randomMarket } from "./helpers.js";

describe("exhaustive enumeration cross-check", () => {
  it("algorithm output is always in the enumerated stable set (random tiny markets)", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const applicantCount = 3 + (seed % 3);
      const institutionCount = 2 + (seed % 2);
      const market = randomMarket(seed, applicantCount, institutionCount);
      const result = createSession(market).solve({ enumerate: true });
      const enumeration = result.enumeration;
      assert.ok(enumeration !== undefined, `seed ${seed}`);
      assert.ok(!enumeration.exhausted, `seed ${seed}: enumeration budget exceeded`);
      assert.ok(result.certificate.feasible, `seed ${seed}: infeasible matching`);
      assert.ok(result.certificate.stable, `seed ${seed}: blocking pair ${JSON.stringify(result.certificate.blockingPairs[0] ?? null)}`);
      assert.ok(
        enumeration.algorithmMatchingInStableSet,
        `seed ${seed}: algorithm result missing from enumerated stable set`,
      );
      assert.ok(
        enumeration.stableMatchings.length >= 1,
        `seed ${seed}: enumeration found no stable matching but algorithm did`,
      );
    }
  });

  it("enumerated stable matchings are exactly the ones with no blocking pair", () => {
    const market = randomMarket(7, 4, 2);
    const compiled = buildMarket(market);
    const result = createSession(market).solve({ enumerate: true });
    const enumeration = result.enumeration;
    assert.ok(enumeration !== undefined);
    for (const record of enumeration.stableMatchings) {
      const certificate = certify(compiled, new Map(Object.entries(record)));
      assert.ok(certificate.stable);
    }
    assert.ok(enumeration.feasibleCount >= enumeration.stableMatchings.length);
  });

  it("solves a maximum-size instance (10 applicants, 6 institutions)", () => {
    const market = randomMarket(99, 10, 6);
    const result = createSession(market).solve();
    assert.ok(result.certificate.feasible);
    assert.ok(result.certificate.stable);
    assert.equal(Object.keys(result.matching).length +
      result.certificate.unassigned.length, 10);
  });

  it("enforces the 10 applicants / 6 institutions limits", () => {
    const tooManyApplicants: MarketInput = {
      applicants: Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, prefers: [] })),
      institutions: [],
    };
    assert.throws(() => createSession(tooManyApplicants), /too many applicants/);
    const tooManyInstitutions: MarketInput = {
      applicants: [],
      institutions: Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, capacity: 1, prefers: [] })),
    };
    assert.throws(() => createSession(tooManyInstitutions), /too many institutions/);
  });

  it("rejects invalid market descriptions", () => {
    const duplicate: MarketInput = {
      applicants: [
        { id: "a1", prefers: [] },
        { id: "a1", prefers: [] },
      ],
      institutions: [],
    };
    assert.throws(() => createSession(duplicate), /duplicate applicant id/);
    const dangling: MarketInput = {
      applicants: [{ id: "a1", prefers: [["ghost"]] }],
      institutions: [],
    };
    assert.throws(() => createSession(dangling), /unknown id/);
  });
});
