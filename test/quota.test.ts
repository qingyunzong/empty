import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarket,
  checkAllocation,
  checkMembers,
  recordToAllocation,
} from "../src/model";
import { findBlockingPairs, isStable } from "../src/stability";
import { buildCertificate, verifyCertificate } from "../src/certificate";
import { enumerateAllocations } from "../src/enumerate";
import { solve } from "../src/solver";
import { mulberry32, randomMarketInput } from "./helpers";

const NESTED_QUOTA_MARKET = {
  applicants: [
    { id: "a1", categories: ["X"], prefs: ["i1", "i2"] },
    { id: "a2", categories: ["X"], prefs: ["i1", "i2"] },
    { id: "a3", categories: [], prefs: ["i1", "i2"] },
  ],
  institutions: [
    { id: "i1", capacity: 2, quotas: [{ category: "X", quota: 1 }], prefs: ["a1", "a2", "a3"] },
    { id: "i2", capacity: 1, prefs: ["a3", "a2", "a1"] },
  ],
};

const MULTI_CATEGORY_MARKET = {
  applicants: [
    { id: "c", categories: ["X", "Y"], prefs: ["i1", "i2"] },
    { id: "x", categories: ["X"], prefs: ["i1", "i2"] },
    { id: "y", categories: ["Y"], prefs: ["i1", "i2"] },
  ],
  institutions: [
    {
      id: "i1",
      capacity: 2,
      quotas: [
        { category: "X", quota: 1 },
        { category: "Y", quota: 1 },
      ],
      prefs: ["c", "x", "y"],
    },
    { id: "i2", capacity: 3, prefs: ["y", "x", "c"] },
  ],
};

const NO_STABLE_MARKET = {
  applicants: [
    { id: "a1", categories: ["X", "Y"], prefs: ["i2"] },
    { id: "a2", categories: ["Y"], prefs: ["i2", "i1"] },
    { id: "a3", categories: ["X"], prefs: ["i1", "i2"] },
  ],
  institutions: [
    { id: "i1", capacity: 1, prefs: ["a2", "a1", "a3"] },
    {
      id: "i2",
      capacity: 2,
      quotas: [{ category: "X", quota: 1, children: [{ category: "Y", quota: 1 }] }],
      prefs: ["a3", "a1", "a2"],
    },
  ],
};

test("nested quota binds: at most one X-category admit at i1", () => {
  const market = buildMarket(NESTED_QUOTA_MARKET);
  const result = solve(market);
  assert.equal(result.status, "stable");
  if (result.status !== "stable") return;
  assert.equal(result.method, "exhaustive-enumeration");
  assert.equal(result.stableCount, 1);
  assert.deepEqual(result.allocation, { a1: "i1", a2: "i2", a3: "i1" });
  const verification = verifyCertificate(market, result.certificate);
  assert.deepEqual(verification.errors, []);
  const evidence = result.certificate.feasibility.find((f) => f.institution === "i1")!;
  assert.deepEqual(evidence.quotas, [{ path: "X", category: "X", count: 1, quota: 1 }]);
  assert.deepEqual(evidence.members, ["a1", "a3"]);
});

test("multi-category applicant counts toward every matching quota node", () => {
  const market = buildMarket(MULTI_CATEGORY_MARKET);
  const inst = market.institutionById.get("i1")!;
  assert.equal(checkMembers(market, inst, ["c", "x"]).ok, false); // X count 2 > 1
  assert.equal(checkMembers(market, inst, ["c", "y"]).ok, false); // Y count 2 > 1
  assert.equal(checkMembers(market, inst, ["x", "y"]).ok, true);
  assert.equal(checkMembers(market, inst, ["c"]).ok, true);
});

test("replacement rule: institution may reject an arbitrary old set for a preferred applicant", () => {
  const market = buildMarket(MULTI_CATEGORY_MARKET);
  const allocation = recordToAllocation({ c: "i2", x: "i1", y: "i1" });
  const blocking = findBlockingPairs(market, allocation);
  const pair = blocking.find((b) => b.applicant === "c" && b.institution === "i1");
  assert.ok(pair, "expected (c, i1) to block");
  assert.deepEqual(pair!.replacementSet, ["x", "y"]); // rejects BOTH current members
  assert.deepEqual(pair!.resultingMembers, ["c"]);
  assert.equal(isStable(market, allocation), false);
});

test("solve finds the unique stable allocation under nested quotas", () => {
  const market = buildMarket(MULTI_CATEGORY_MARKET);
  const result = solve(market);
  assert.equal(result.status, "stable");
  if (result.status !== "stable") return;
  assert.deepEqual(result.allocation, { c: "i1", x: "i2", y: "i2" });
  assert.ok(verifyCertificate(market, result.certificate).ok);
});

test("no-stable-existence proof: every feasible allocation has a blocking pair", () => {
  const market = buildMarket(NO_STABLE_MARKET);
  const result = solve(market);
  assert.equal(result.status, "no-stable-exists");
  if (result.status !== "no-stable-exists") return;
  assert.equal(result.proof.feasibleAllocationsChecked, 11);
  assert.equal(result.proof.unstableCount, 11);
  assert.equal(result.proof.truncated, false);
  assert.equal(result.proof.unstableWitnesses.length, 11);
  for (const witness of result.proof.unstableWitnesses) {
    const allocation = recordToAllocation(witness.allocation);
    assert.deepEqual(checkAllocation(market, allocation), []);
    const blocking = findBlockingPairs(market, allocation);
    assert.ok(blocking.length > 0);
    assert.ok(
      blocking.some((b) => JSON.stringify(b) === JSON.stringify(witness.blockingPair)),
      "witness blocking pair must recompute",
    );
  }
});

test("certificate verification rejects tampered certificates", () => {
  const market = buildMarket(NESTED_QUOTA_MARKET);
  const result = solve(market);
  if (result.status !== "stable") throw new Error("expected stable");
  assert.ok(verifyCertificate(market, result.certificate).ok);
  const tampered = {
    ...result.certificate,
    allocation: { ...result.certificate.allocation, a2: "i1" },
  };
  assert.equal(verifyCertificate(market, tampered).ok, false);
});

test("random nested-quota instances: enumeration, certificates and solver agree", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = mulberry32(seed * 7919);
    const input = randomMarketInput(rng, {
      applicants: 4,
      institutions: 3,
      maxCapacity: 2,
      categories: ["X", "Y"],
      categoryProb: 0.5,
      quotaProb: 0.8,
      tieProb: 0.2,
      acceptProb: 0.8,
    });
    const market = buildMarket(input);
    const enumeration = enumerateAllocations(market);
    assert.equal(enumeration.truncated, false, `seed ${seed}`);
    assert.equal(
      enumeration.feasibleCount,
      enumeration.stableAllocations.length + enumeration.unstableCount,
      `seed ${seed}`,
    );
    for (const record of enumeration.stableAllocations) {
      const allocation = recordToAllocation(record);
      assert.ok(isStable(market, allocation), `seed ${seed}: stable allocation must verify`);
      const cert = buildCertificate(market, allocation);
      assert.ok(verifyCertificate(market, cert).ok, `seed ${seed}: certificate must verify`);
    }
    for (const witness of enumeration.unstableWitnesses) {
      assert.equal(
        isStable(market, recordToAllocation(witness.allocation)),
        false,
        `seed ${seed}: witness allocation must be unstable`,
      );
    }
    const result = solve(market);
    if (enumeration.stableAllocations.length > 0) {
      assert.equal(result.status, "stable", `seed ${seed}`);
      if (result.status === "stable") {
        assert.ok(verifyCertificate(market, result.certificate).ok, `seed ${seed}`);
        assert.ok(
          enumeration.stableAllocations.some(
            (record) => JSON.stringify(record) === JSON.stringify(result.status === "stable" ? result.allocation : null),
          ),
          `seed ${seed}: solver allocation must be among enumerated stable allocations`,
        );
      }
    } else {
      assert.equal(result.status, "no-stable-exists", `seed ${seed}`);
    }
  }
});

test("enumerated feasible allocations only contain mutually acceptable pairs", () => {
  const rng = mulberry32(12345);
  const input = randomMarketInput(rng, {
    applicants: 5,
    institutions: 3,
    maxCapacity: 2,
    categories: ["X"],
    categoryProb: 0.5,
    quotaProb: 0.7,
    tieProb: 0.1,
    acceptProb: 0.6,
  });
  const market = buildMarket(input);
  const enumeration = enumerateAllocations(market);
  assert.ok(enumeration.feasibleCount > 0);
  for (const record of [...enumeration.stableAllocations, ...enumeration.unstableWitnesses.map((w) => w.allocation)]) {
    assert.deepEqual(checkAllocation(market, recordToAllocation(record)), []);
  }
});
