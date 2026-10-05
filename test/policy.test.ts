import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, ge, gt, not, or, evalExpr } from "../src/expr.js";
import { parseRational, rational } from "../src/rational.js";
import { decide, explain, rule, type Policy } from "../src/policy.js";

test("missing attribute evaluates to unknown, not false", () => {
  assert.equal(evalExpr(eq("role", "admin"), {}), "unknown");
  assert.equal(evalExpr(ge("age", rational(18n)), {}), "unknown");
  assert.equal(evalExpr(not(eq("role", "admin")), {}), "unknown");
  assert.equal(evalExpr(and(eq("role", "admin"), eq("mfa", true)), { mfa: true }), "unknown");
  // ...but a definite false still dominates an unknown in `and`.
  assert.equal(evalExpr(and(eq("role", "admin"), eq("mfa", true)), { mfa: false }), "false");
});

test("rational comparisons are exact", () => {
  const twoThirds = parseRational("2/3");
  assert.equal(evalExpr(ge("score", twoThirds), { score: twoThirds }), "true");
  assert.equal(evalExpr(gt("score", twoThirds), { score: parseRational("0.6666") }), "false");
  assert.equal(evalExpr(gt("score", twoThirds), { score: parseRational("0.6667") }), "true");
});

test("ordering on non-rationals is unknown; cross-type eq/ne stay decidable", () => {
  assert.equal(evalExpr(gt("n", rational(1n)), { n: "lots" }), "unknown");
  assert.equal(evalExpr(eq("n", rational(1n)), { n: true }), "false");
  assert.equal(evalExpr(eq("role", "admin"), { role: "admin" }), "true");
  assert.equal(evalExpr(eq("role", "admin"), { role: "user" }), "false");
});

const policy: Policy = {
  name: "example",
  rules: [
    rule("r-allow-admin", "allow", and(eq("role", "admin"), eq("mfa", true))),
    rule("r-allow-staff", "allow", and(eq("dept", "eng"), ge("level", rational(5n)))),
    rule("r-deny-banned", "deny", eq("banned", true)),
    rule("r-deny-low-score", "deny", ge("risk", parseRational("9/10"))),
  ],
};

test("only a true allow rule grants access", () => {
  assert.equal(decide(policy, { role: "admin", mfa: true }), "allow");
  // allow rule unknown (mfa missing) -> default deny
  assert.equal(decide(policy, { role: "admin" }), "deny");
  // allow rule false -> default deny
  assert.equal(decide(policy, { role: "user", mfa: true }), "deny");
});

test("any true deny rule rejects, overriding true allows", () => {
  assert.equal(decide(policy, { role: "admin", mfa: true, banned: true }), "deny");
  assert.equal(
    decide(policy, { dept: "eng", level: rational(7n), risk: parseRational("0.95") }),
    "deny",
  );
});

test("unknown deny does not automatically reject", () => {
  // banned and risk are both missing -> deny rules unknown; allow still grants.
  assert.equal(decide(policy, { dept: "eng", level: rational(5n) }), "allow");
});

test("explain reports per-rule three-valued results and the reason", () => {
  const x = explain(policy, { role: "admin" });
  assert.equal(x.decision, "deny");
  assert.deepEqual(
    x.ruleResults.map((r) => r.result),
    ["unknown", "unknown", "unknown", "unknown"],
  );
  assert.match(x.reason, /default deny/);
});

test("empty policy denies everything", () => {
  assert.equal(decide({ rules: [] }, { role: "admin" }), "deny");
});

test("or-composed allow rule grants when either branch is true", () => {
  const p: Policy = {
    rules: [rule("r", "allow", or(eq("a", true), eq("b", true)))],
  };
  assert.equal(decide(p, { b: true }), "allow");
  assert.equal(decide(p, { a: false }), "deny"); // other branch unknown -> not granted
});
