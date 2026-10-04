import { test } from "node:test";
import assert from "node:assert";
import {
  explain,
  replay,
  MAX_INPUTS,
  type Evidence,
  type ExplainFn,
  type Inputs,
} from "../src/explain";

const cartFn: ExplainFn = (inputs, claim) => {
  const total =
    (inputs.price as number) * (inputs.qty as number) +
    (inputs.tax as number) -
    (inputs.coupon as number);
  claim(total <= (inputs.budget as number), "total-within-budget");
};

const cartInputs: Inputs = {
  price: 30,
  qty: 2,
  tax: 5,
  coupon: 0,
  budget: 50,
  note: "gift",
};

test("assertion depending on multiple inputs yields minimal slice of exactly those inputs", () => {
  const result = explain(cartFn, cartInputs);
  assert.equal(result.kind, "assertion-failure");
  if (result.kind !== "assertion-failure") return;
  assert.equal(result.message, "total-within-budget");
  assert.deepEqual(result.minimal, ["budget", "coupon", "price", "qty", "tax"]);
  assert.ok(!result.minimal.includes("note"));
});

test("inputs read only in unexecuted conditional branches are not counted as sources", () => {
  const fn: ExplainFn = (inputs, claim) => {
    if (inputs.mode === "strict") {
      claim((inputs.x as number) > 0, "x-positive");
    } else {
      claim((inputs.y as number) > 0, "y-positive");
    }
  };
  const result = explain(fn, { mode: "relaxed", x: -999, y: -1, extra: 1 });
  assert.equal(result.kind, "assertion-failure");
  if (result.kind !== "assertion-failure") return;
  assert.equal(result.message, "y-positive");
  assert.deepEqual(result.minimal, ["mode", "y"]);
  assert.ok(!result.reads.includes("x"), "x is never read on the relaxed path");
  assert.ok(!result.minimal.includes("x"));
  assert.ok(!result.minimal.includes("extra"));
});

test("plain errors are reported separately from assertion failures", () => {
  const errorFn: ExplainFn = () => {
    throw new TypeError("boom");
  };
  const result = explain(errorFn, { a: 1 });
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.errorName, "TypeError");
  assert.equal(result.errorMessage, "boom");
  assert.ok(!("minimal" in result), "errors carry no cause slice");
  assert.ok(!("evidence" in result), "errors carry no failure evidence");
});

test("exhaustive single-input removal verifies slice minimality over all inputs", () => {
  const result = explain(cartFn, cartInputs);
  assert.equal(result.kind, "assertion-failure");
  if (result.kind !== "assertion-failure") return;
  const checks = result.evidence.minimalityChecks;
  assert.equal(checks.length, Object.keys(cartInputs).length);
  for (const check of checks) {
    if (check.role === "slice-member") {
      assert.equal(check.reproduced, false, `removing ${check.removed} must break reproduction`);
    } else {
      assert.equal(check.reproduced, true, `removing ${check.removed} must keep reproduction`);
    }
  }
  assert.equal(result.consistent, true);
  assert.equal(result.evidence.sufficiency.reproduced, true);
  assert.deepEqual(result.evidence.sufficiency.kept, result.minimal);
});

test("at most 20 inputs are supported", () => {
  const noop: ExplainFn = () => {};
  const twenty: Inputs = {};
  for (let i = 0; i < MAX_INPUTS; i++) twenty[`k${i}`] = i;
  assert.equal(explain(noop, twenty).kind, "success");
  const twentyOne: Inputs = { ...twenty, k20: 20 };
  assert.throws(() => explain(noop, twentyOne), RangeError);
});

test("evidence is replayable and tampering is detected", () => {
  const result = explain(cartFn, cartInputs);
  assert.equal(result.kind, "assertion-failure");
  if (result.kind !== "assertion-failure") return;
  const evidence: Evidence = result.evidence;

  const okReplay = replay(evidence, cartFn);
  assert.equal(okReplay.ok, true, okReplay.reason);

  const tamperedMinimal: Evidence = { ...evidence, minimal: [...evidence.minimal, "note"] };
  const badSlice = replay(tamperedMinimal, cartFn);
  assert.equal(badSlice.ok, false);
  assert.ok(badSlice.reason.startsWith("digest-mismatch"));

  const tamperedInputs: Evidence = {
    ...evidence,
    inputs: { ...evidence.inputs, budget: 999 },
  };
  const badInputs = replay(tamperedInputs, cartFn);
  assert.equal(badInputs.ok, false);
  assert.ok(badInputs.reason.startsWith("digest-mismatch"));

  const passingFn: ExplainFn = (_inputs, claim) => claim(true, "total-within-budget");
  const wrongFn = replay(evidence, passingFn);
  assert.equal(wrongFn.ok, false);
  assert.ok(wrongFn.reason.startsWith("expected assertion-failure"));
});

test("passing assertions report success with read provenance", () => {
  const fn: ExplainFn = (inputs, claim) => {
    claim((inputs.a as number) + (inputs.b as number) > 0, "sum-positive");
  };
  const result = explain(fn, { a: 2, b: 3, unused: 9 });
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.deepEqual(result.reads, ["a", "b"]);
});

test("gating earlier claims surface as inconsistent removal checks", () => {
  const fn: ExplainFn = (inputs, claim) => {
    claim((inputs.guard as number) > 0, "guard-positive");
    claim((inputs.value as number) > 0, "value-positive");
  };
  const result = explain(fn, { guard: 1, value: -1 });
  assert.equal(result.kind, "assertion-failure");
  if (result.kind !== "assertion-failure") return;
  assert.deepEqual(result.minimal, ["value"]);
  assert.equal(result.consistent, false);
  const guardCheck = result.evidence.minimalityChecks.find((c) => c.removed === "guard");
  assert.ok(guardCheck);
  assert.equal(guardCheck.reproduced, false);
  assert.equal(guardCheck.outcome, "assertion-failure(absent-input):guard-positive");
});
