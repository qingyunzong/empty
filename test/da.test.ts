import test from "node:test";
import assert from "node:assert/strict";
import { allocationToRecord, buildMarket, recordToAllocation } from "../src/model";
import { deferredAcceptance } from "../src/da";
import { enumerateAllocations } from "../src/enumerate";
import { findBlockingPairs, isStable } from "../src/stability";
import { buildCertificate, verifyCertificate } from "../src/certificate";
import { solve } from "../src/solver";
import { mulberry32, randomMarketInput } from "./helpers";

test("deferred acceptance on a hand-verified 3x3 instance", () => {
  const market = buildMarket({
    applicants: [
      { id: "a1", prefs: ["i1", "i2", "i3"] },
      { id: "a2", prefs: ["i2", "i1", "i3"] },
      { id: "a3", prefs: ["i1", "i2", "i3"] },
    ],
    institutions: [
      { id: "i1", capacity: 1, prefs: ["a2", "a1", "a3"] },
      { id: "i2", capacity: 1, prefs: ["a1", "a2", "a3"] },
      { id: "i3", capacity: 1, prefs: ["a1", "a2", "a3"] },
    ],
  });
  const allocation = deferredAcceptance(market);
  assert.deepEqual(allocationToRecord(allocation), { a1: "i1", a2: "i2", a3: "i3" });
  assert.equal(isStable(market, allocation), true);
});

test("deferred acceptance respects capacities and unacceptability", () => {
  const market = buildMarket({
    applicants: [
      { id: "a1", prefs: ["i1", "i2"] },
      { id: "a2", prefs: ["i1"] },
      { id: "a3", prefs: ["i1", "i2"] },
    ],
    institutions: [
      { id: "i1", capacity: 1, prefs: ["a1", "a3"] }, // a2 unacceptable to i1
      { id: "i2", capacity: 1, prefs: ["a3", "a1"] }, // a2 unacceptable to i2
    ],
  });
  const allocation = deferredAcceptance(market);
  const record = allocationToRecord(allocation);
  assert.deepEqual(record, { a1: "i1", a3: "i2" });
  assert.equal(record.a2, undefined); // a2 listed only unacceptable institutions
  assert.equal(findBlockingPairs(market, allocation).length, 0);
});

test("certificate verifies for DA output", () => {
  const market = buildMarket({
    applicants: [
      { id: "a1", prefs: ["i1", "i2"] },
      { id: "a2", prefs: ["i2", "i1"] },
    ],
    institutions: [
      { id: "i1", capacity: 1, prefs: ["a1", "a2"] },
      { id: "i2", capacity: 1, prefs: ["a2", "a1"] },
    ],
  });
  const result = solve(market);
  assert.equal(result.status, "stable");
  if (result.status !== "stable") return;
  assert.equal(result.method, "deferred-acceptance");
  const verification = verifyCertificate(market, result.certificate);
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.ok, true);
});

test("cross-check: DA output is among enumerated stable allocations on random tiny instances", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = mulberry32(seed);
    const input = randomMarketInput(rng, {
      applicants: 4,
      institutions: 3,
      maxCapacity: 2,
      categories: [],
      categoryProb: 0,
      quotaProb: 0,
      tieProb: 0.3,
      acceptProb: 0.75,
    });
    const market = buildMarket(input);
    const da = deferredAcceptance(market);
    assert.equal(isStable(market, da), true, `seed ${seed}: DA output must be stable`);
    const enumeration = enumerateAllocations(market);
    assert.equal(enumeration.truncated, false, `seed ${seed}: enumeration must complete`);
    assert.ok(
      enumeration.stableAllocations.length >= 1,
      `seed ${seed}: capacity-only markets always have a stable allocation`,
    );
    const daRecord = JSON.stringify(allocationToRecord(da));
    assert.ok(
      enumeration.stableAllocations.some((s) => JSON.stringify(s) === daRecord),
      `seed ${seed}: DA allocation must appear in enumerated stable set`,
    );
    for (const stable of enumeration.stableAllocations) {
      const cert = buildCertificate(market, recordToAllocation(stable));
      assert.equal(verifyCertificate(market, cert).ok, true, `seed ${seed}: certificate must verify`);
    }
  }
});
