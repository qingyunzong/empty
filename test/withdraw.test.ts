import test from "node:test";
import assert from "node:assert/strict";
import { buildMarket } from "../src/model";
import { solve, withdrawApplicants } from "../src/solver";
import { verifyCertificate } from "../src/certificate";

test("withdrawal triggers full recomputation of the allocation", () => {
  const market = buildMarket({
    applicants: [
      { id: "a1", prefs: ["i1", "i2"] },
      { id: "a2", prefs: ["i1", "i2"] },
    ],
    institutions: [
      { id: "i1", capacity: 1, prefs: ["a1", "a2"] },
      { id: "i2", capacity: 1, prefs: ["a2", "a1"] },
    ],
  });
  const before = solve(market);
  if (before.status !== "stable") throw new Error("expected stable");
  assert.deepEqual(before.allocation, { a1: "i1", a2: "i2" });

  const reduced = withdrawApplicants(market, ["a1"]);
  const after = solve(reduced);
  if (after.status !== "stable") throw new Error("expected stable");
  assert.deepEqual(after.allocation, { a2: "i1" }); // a2 moves up to i1
  assert.ok(verifyCertificate(reduced, after.certificate).ok);
});

test("withdrawal in quota markets drops the applicant from all preference lists", () => {
  const market = buildMarket({
    applicants: [
      { id: "a1", categories: ["X"], prefs: ["i1"] },
      { id: "a2", categories: [], prefs: ["i1"] },
    ],
    institutions: [
      { id: "i1", capacity: 2, quotas: [{ category: "X", quota: 1 }], prefs: ["a1", "a2"] },
    ],
  });
  const reduced = withdrawApplicants(market, ["a1"]);
  assert.equal(reduced.applicantById.has("a1"), false);
  assert.deepEqual(reduced.institutions[0]!.strictPrefs, ["a2"]);
  const after = solve(reduced);
  if (after.status !== "stable") throw new Error("expected stable");
  assert.deepEqual(after.allocation, { a2: "i1" });
  assert.ok(verifyCertificate(reduced, after.certificate).ok);
});

test("withdrawing an unassigned applicant keeps the rest stable", () => {
  const market = buildMarket({
    applicants: [
      { id: "a1", prefs: ["i1"] },
      { id: "a2", prefs: ["i1"] },
      { id: "a3", prefs: [] },
    ],
    institutions: [{ id: "i1", capacity: 1, prefs: ["a1", "a2"] }],
  });
  const reduced = withdrawApplicants(market, ["a3"]);
  const after = solve(reduced);
  if (after.status !== "stable") throw new Error("expected stable");
  assert.deepEqual(after.allocation, { a1: "i1" });
  assert.throws(() => withdrawApplicants(market, ["nope"]));
});
