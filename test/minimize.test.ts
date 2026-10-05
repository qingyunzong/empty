import { test } from "node:test";
import assert from "node:assert/strict";
import { and, constExpr, eq, ge, gt, le } from "../src/expr.js";
import { parseRational, rational } from "../src/rational.js";
import { decide, rule, type Policy } from "../src/policy.js";
import {
  collectShapes,
  enumerateAssignments,
  minimizePolicy,
  ExhaustionLimitError,
} from "../src/minimize.js";

test("boolean attribute domain is {true, false, missing}", () => {
  const shapes = collectShapes({ rules: [rule("r", "allow", eq("a", true))] });
  assert.equal(shapes.length, 1);
  assert.deepEqual(shapes[0].domain, [true, false, undefined]);
  assert.equal(enumerateAssignments(shapes, 100).length, 3);
});

test("rational thresholds partition the line into sampled cells", () => {
  const p: Policy = {
    rules: [rule("r", "allow", and(ge("x", rational(0n)), le("x", rational(1n))))],
  };
  const shapes = collectShapes(p);
  // thresholds 0 and 1 -> samples: -1, 0, 1/2, 1, 2, plus missing
  assert.deepEqual(
    shapes[0].domain.map((v) => (v === undefined ? "missing" : v)),
    [rational(-1n), rational(0n), rational(1n, 2n), rational(1n), rational(2n), "missing"],
  );
  assert.equal(enumerateAssignments(shapes, 100).length, 6);
});

test("string attribute domain adds a fresh 'other' literal and missing", () => {
  const shapes = collectShapes({ rules: [rule("r", "allow", eq("s", "x"))] });
  assert.deepEqual(shapes[0].domain, ["x", "__other__", undefined]);
});

test("enumeration size is the cartesian product of domains", () => {
  const p: Policy = {
    rules: [rule("r", "allow", and(eq("a", true), eq("b", false)))],
  };
  assert.equal(enumerateAssignments(collectShapes(p), 100).length, 9);
});

test("enumeration beyond the limit raises ExhaustionLimitError", () => {
  const p: Policy = {
    rules: [
      rule("r", "allow", and(eq("a", true), and(eq("b", true), and(eq("c", true), eq("d", true))))),
    ],
  };
  assert.throws(() => enumerateAssignments(collectShapes(p), 10), ExhaustionLimitError);
});

test("minimizer removes a rule subsumed by a broader rule", () => {
  // r2 (admin) is subsumed by r1 (anyone with mfa) -> r2 is redundant.
  const p: Policy = {
    rules: [
      rule("r1", "allow", eq("mfa", true)),
      rule("r2", "allow", and(eq("mfa", true), eq("role", "admin"))),
    ],
  };
  const res = minimizePolicy(p);
  assert.equal(res.verified, true);
  assert.deepEqual(
    res.policy.rules.map((r) => r.id),
    ["r1"],
  );
  assert.deepEqual(
    res.removed.map((r) => r.id),
    ["r2"],
  );
  assert.equal(res.assignmentsChecked, 9); // 2 boolean attrs -> 3 x 3
});

test("minimizer removes a rule masked by a deny rule", () => {
  // Wherever r-allow would grant (banned === true), r-deny already denies.
  const p: Policy = {
    rules: [
      rule("r-deny", "deny", eq("banned", true)),
      rule("r-allow", "allow", eq("banned", true)),
    ],
  };
  const res = minimizePolicy(p);
  assert.equal(res.verified, true);
  assert.deepEqual(
    res.policy.rules.map((r) => r.id),
    ["r-deny"],
  );
});

test("minimizer removes a never-true rule (contradictory condition)", () => {
  const p: Policy = {
    rules: [
      rule("r1", "allow", eq("a", true)),
      rule("r2", "allow", and(gt("x", rational(1n)), le("x", rational(0n)))),
    ],
  };
  const res = minimizePolicy(p);
  assert.equal(res.verified, true);
  assert.deepEqual(
    res.policy.rules.map((r) => r.id),
    ["r1"],
  );
});

test("irredundant policy is returned unchanged", () => {
  const p: Policy = {
    rules: [
      rule("r1", "allow", eq("a", true)),
      rule("r2", "deny", eq("b", true)),
    ],
  };
  const res = minimizePolicy(p);
  assert.equal(res.verified, true);
  assert.equal(res.removed.length, 0);
  assert.deepEqual(
    res.policy.rules.map((r) => r.id),
    ["r1", "r2"],
  );
});

test("minimized policy decides identically on every enumerated assignment", () => {
  const p: Policy = {
    rules: [
      rule("r1", "allow", and(eq("role", "admin"), eq("mfa", true))),
      rule("r2", "allow", and(eq("role", "admin"), and(eq("mfa", true), ge("level", rational(3n))))),
      rule("r3", "deny", ge("risk", parseRational("9/10"))),
      rule("r4", "allow", constExpr(false)),
    ],
  };
  const res = minimizePolicy(p);
  assert.equal(res.verified, true);
  assert.deepEqual(
    res.policy.rules.map((r) => r.id),
    ["r1", "r3"],
  );
  // Independent re-verification over the ORIGINAL policy's attribute space.
  const space = enumerateAssignments(collectShapes(p), 100_000);
  for (const attrs of space) {
    assert.equal(decide(res.policy, attrs), decide(p, attrs));
  }
});

test("minimizer refuses to guess when the space exceeds the cap", () => {
  const attrs = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const p: Policy = {
    rules: [rule("r", "allow", and(...attrs.map((a) => eq(a, true))))],
  };
  const res = minimizePolicy(p, { maxAssignments: 100 });
  assert.equal(res.verified, false);
  assert.equal(res.policy, p); // original returned untouched
  assert.match(res.reason ?? "", /exhaustive enumeration/);
});
