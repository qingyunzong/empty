import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseRule,
  matches,
  includes,
  counterexample,
  relate,
  type Rule,
} from "../src/rules.js";

function mustParse(raw: string): Rule {
  const r = parseRule(raw);
  assert.ok(r.ok, `expected "${raw}" to parse`);
  return (r as { ok: true; rule: Rule }).rule;
}

function expectRuleError(raw: string, error: string): void {
  const r = parseRule(raw);
  assert.ok(!r.ok, `expected "${raw}" to be rejected`);
  if (!r.ok) assert.equal(r.error, error, `"${raw}": ${r.detail}`);
}

test("rule parsing: exact and wildcard forms", () => {
  assert.deepEqual(mustParse("Example.COM."), { kind: "exact", domain: "example.com" });
  assert.deepEqual(mustParse("*.Example.COM."), { kind: "wildcard", suffix: "example.com" });
  assert.deepEqual(mustParse("*.com"), { kind: "wildcard", suffix: "com" }); // one layer is enough
});

test("rule parsing: wildcard placement restrictions", () => {
  expectRuleError("*", "WILDCARD_NO_SUFFIX");
  expectRuleError("*.", "WILDCARD_NO_SUFFIX");
  expectRuleError("*.*.com", "BAD_WILDCARD");
  expectRuleError("a.*.com", "BAD_WILDCARD");
  expectRuleError("f*o.com", "BAD_WILDCARD");
  expectRuleError("*foo.com", "BAD_WILDCARD");
});

test("rule parsing: domain validation still applies to both forms", () => {
  expectRuleError("*.1.2.3.4", "IP_MASQUERADE");
  expectRuleError("*.exämple.com", "NON_ASCII");
  expectRuleError("*.a..com", "EMPTY_LABEL");
  expectRuleError("1.2.3.4", "IP_MASQUERADE");
});

test("matching: exact rules match only themselves", () => {
  const r = mustParse("example.com");
  assert.ok(matches(r, "example.com"));
  assert.ok(matches(r, "EXAMPLE.com.")); // normalization applies to candidates too
  assert.ok(!matches(r, "a.example.com"));
  assert.ok(!matches(r, "example.com.evil.com"));
  assert.ok(!matches(r, "not a domain!!"));
});

test("matching: wildcards need at least one extra label, any depth", () => {
  const r = mustParse("*.example.com");
  assert.ok(matches(r, "a.example.com"));
  assert.ok(matches(r, "a.b.example.com"));
  assert.ok(matches(r, "A.Example.COM."));
  assert.ok(!matches(r, "example.com")); // the bare suffix is not matched
  assert.ok(!matches(r, "example.com."));
  assert.ok(!matches(r, "aexample.com"));
  assert.ok(!matches(r, "a.example.com.evil.com"));
});

test("inclusion: exact vs exact", () => {
  const a = mustParse("a.com");
  const b = mustParse("b.com");
  assert.ok(includes(a, a));
  assert.ok(!includes(a, b));
  assert.ok(!includes(b, a));
});

test("inclusion: wildcard vs exact", () => {
  const wild = mustParse("*.a.com");
  const inside = mustParse("x.a.com");
  const bare = mustParse("a.com");
  assert.ok(includes(wild, inside)); // x.a.com ends with .a.com
  assert.ok(!includes(inside, wild)); // a singleton cannot cover an infinite set
  assert.ok(!includes(wild, bare)); // wildcard does not match the bare suffix
  assert.ok(!includes(bare, wild));
});

test("inclusion: wildcard vs wildcard is suffix inclusion", () => {
  const outer = mustParse("*.a.com");
  const inner = mustParse("*.x.a.com");
  const other = mustParse("*.b.com");
  assert.ok(includes(outer, inner));
  assert.ok(!includes(inner, outer));
  assert.ok(includes(outer, outer));
  assert.ok(!includes(outer, other));
  assert.ok(!includes(other, outer));
});

test("counterexamples witness the non-inclusion", () => {
  const a = mustParse("a.com");
  const b = mustParse("b.com");
  assert.equal(counterexample(a, b), "b.com");
  assert.equal(counterexample(a, a), null);

  const outer = mustParse("*.a.com");
  const inner = mustParse("*.x.a.com");
  assert.equal(counterexample(outer, inner), null); // outer ⊇ inner
  const ce = counterexample(inner, outer);
  assert.ok(ce !== null);
  assert.ok(matches(outer, ce) && !matches(inner, ce));

  // Collision avoidance: the exact rule shadows the first candidate "x.a.com",
  // so the generator must move on to another label.
  const shadow = mustParse("x.a.com");
  const wild = mustParse("*.a.com");
  const ce2 = counterexample(shadow, wild);
  assert.ok(ce2 !== null && ce2 !== "x.a.com");
  assert.ok(matches(wild, ce2) && !matches(shadow, ce2));
});

test("relation summary", () => {
  assert.equal(relate(mustParse("a.com"), mustParse("A.com.")), "equivalent");
  assert.equal(relate(mustParse("*.com"), mustParse("a.com")), "includes");
  assert.equal(relate(mustParse("a.com"), mustParse("*.com")), "included-by");
  assert.equal(relate(mustParse("a.com"), mustParse("*.a.com")), "incomparable");
  assert.equal(relate(mustParse("*.a.com"), mustParse("*.b.com")), "incomparable");
});
