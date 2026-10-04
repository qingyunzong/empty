import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/session.js";
import type { MarketInput } from "../src/types.js";

const market: MarketInput = {
  applicants: [
    { id: "a1", prefers: [["X"], ["Y"]] },
    { id: "a2", prefers: [["X"], ["Y"]] },
    { id: "a3", prefers: [["Y"], ["X"]] },
  ],
  institutions: [
    { id: "X", capacity: 1, prefers: [["a1"], ["a2"], ["a3"]] },
    { id: "Y", capacity: 1, prefers: [["a2"], ["a3"], ["a1"]] },
  ],
};

describe("withdrawals and recomputation", () => {
  it("recomputes after an applicant leaves the market", () => {
    const session = createSession(market);
    const before = session.solve({ enumerate: true });
    assert.deepEqual(before.matching, { a1: "X", a2: "Y" });
    assert.deepEqual(before.certificate.unassigned, ["a3"]);

    session.withdrawApplicant("a1");
    const after = session.solve({ enumerate: true });
    assert.deepEqual(after.matching, { a2: "X", a3: "Y" });
    assert.ok(!("a1" in after.matching));
    assert.ok(after.certificate.stable);
    assert.ok(after.enumeration?.algorithmMatchingInStableSet);
  });

  it("recomputes after a single application is withdrawn", () => {
    const session = createSession(market);
    session.withdrawApplication("a1", "X");
    const result = session.solve({ enumerate: true });
    assert.deepEqual(result.matching, { a2: "X", a3: "Y" });
    assert.deepEqual(result.certificate.unassigned, ["a1"]);
    assert.ok(result.certificate.stable);
    assert.ok(result.enumeration?.algorithmMatchingInStableSet);
  });

  it("rejects unknown withdrawals", () => {
    const session = createSession(market);
    assert.throws(() => session.withdrawApplicant("nobody"), /unknown applicant/);
    assert.throws(() => session.withdrawApplication("a1", "Z"), /no application/);
  });
});
