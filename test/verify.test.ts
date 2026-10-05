import assert from "node:assert/strict";
import { test } from "node:test";
import { search, type SearchResult } from "../src/search.js";
import { parseSpec } from "../src/spec.js";
import { decide, enumerateCanonical, enumerateExtensions, verifyResult } from "../src/verify.js";

const differSpec = () =>
  parseSpec({
    attributes: [
      { name: "role", domain: ["admin", "user"] },
      { name: "mfa", domain: [false, true] },
    ],
    policies: {
      a: { rules: [{ when: { role: "admin" }, effect: "permit" }] },
      b: {},
    },
  });

const equivalentSpec = () =>
  parseSpec({
    attributes: [{ name: "x", domain: [0, 1] }],
    policies: {
      a: { rules: [{ when: { x: 0 }, effect: "permit" }] },
      b: { rules: [{ when: { x: 0 }, effect: "permit" }] },
    },
  });

const undecidedSpec = () =>
  parseSpec({
    attributes: [
      { name: "x", domain: [0, 1] },
      { name: "y", domain: [0, 1] },
    ],
    policies: {
      a: { rules: [{ when: { x: 1, y: 1 }, effect: "permit" }] },
      b: {},
    },
  });

test("independent enumeration matches the canonical order", () => {
  const spec = differSpec();
  const expected = [
    {},
    { role: "admin" },
    { role: "user" },
    { mfa: false },
    { mfa: true },
    { role: "admin", mfa: false },
    { role: "admin", mfa: true },
    { role: "user", mfa: false },
    { role: "user", mfa: true },
  ];
  assert.deepEqual([...enumerateCanonical(spec)].map((a) => Object.fromEntries(a)), expected);
});

test("independent total evaluator agrees on extensions", () => {
  const spec = differSpec();
  const witness = new Map<string, string | boolean>([["role", "admin"]]);
  const extensions = [...enumerateExtensions(spec, witness)];
  assert.equal(extensions.length, 2); // mfa = false | true
  for (const total of extensions) {
    assert.equal(decide(spec.policies[0], total), "permit");
    assert.equal(decide(spec.policies[1], total), "deny");
  }
});

test("cross-check passes for DIFFER", () => {
  const spec = differSpec();
  const report = verifyResult(spec, search(spec));
  assert.equal(report.status, "passed");
  assert.equal(report.checks.length, 3);
});

test("cross-check passes for EQUIVALENT", () => {
  const spec = equivalentSpec();
  const report = verifyResult(spec, search(spec));
  assert.equal(report.status, "passed");
});

test("cross-check passes for UNDECIDED", () => {
  const spec = undecidedSpec();
  const report = verifyResult(spec, search(spec, 2));
  assert.equal(report.status, "passed");
});

test("cross-check rejects a fabricated witness", () => {
  const spec = differSpec();
  const fake: SearchResult = {
    verdict: "DIFFER",
    checked: 2,
    space: 9n,
    budget: 100,
    witness: new Map([["role", "user"]]),
    decisions: ["permit", "deny"],
  };
  const report = verifyResult(spec, fake);
  assert.equal(report.status, "failed");
  assert.ok(report.failures.some((f) => f.includes("not constantly permit")));
});

test("cross-check rejects a fabricated EQUIVALENT verdict", () => {
  const spec = differSpec();
  const fake: SearchResult = { verdict: "EQUIVALENT", checked: 9, space: 9n, budget: 100 };
  const report = verifyResult(spec, fake);
  assert.equal(report.status, "failed");
  assert.ok(report.failures.some((f) => f.includes("disagree")));
});

test("cross-check rejects UNDECIDED when the space is actually exhausted", () => {
  const spec = equivalentSpec();
  const fake: SearchResult = { verdict: "UNDECIDED", checked: 3, space: 3n, budget: 3 };
  const report = verifyResult(spec, fake);
  assert.equal(report.status, "failed");
});

test("cross-check reports skipped when the enumeration limit is exceeded", () => {
  const spec = differSpec();
  const report = verifyResult(spec, search(spec), 1);
  assert.equal(report.status, "skipped");
  assert.ok(report.notes.some((n) => n.includes("limit")));
});
