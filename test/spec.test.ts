import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpec, SpecError } from "../src/spec.js";

const base = {
  attributes: [{ name: "x", domain: [0, 1] }],
  policies: {
    a: { rules: [{ when: { x: 1 }, effect: "permit" }] },
    b: { default: "deny", rules: [] },
  },
};

test("accepts a valid spec and applies defaults", () => {
  const spec = parseSpec(base);
  assert.equal(spec.attributes.length, 1);
  assert.equal(spec.policies[0].name, "a");
  assert.equal(spec.policies[0].defaultEffect, "deny");
  assert.equal(spec.policies[1].defaultEffect, "deny");
  assert.equal(spec.budget, undefined);
});

test("rejects more than 20 rules in total", () => {
  const rules = Array.from({ length: 21 }, () => ({ when: { x: 1 }, effect: "deny" }));
  assert.throws(() => parseSpec({ ...base, policies: { a: { rules }, b: { rules: [] } } }), /too many rules: 21/);
});

test("accepts exactly 20 rules", () => {
  const rules = Array.from({ length: 20 }, () => ({ when: { x: 1 }, effect: "deny" }));
  const spec = parseSpec({ ...base, policies: { a: { rules }, b: { rules: [] } } });
  assert.equal(spec.policies[0].rules.length, 20);
});

test("rejects conditions on undeclared attributes", () => {
  const bad = { ...base, policies: { a: { rules: [{ when: { y: 1 }, effect: "permit" }] }, b: {} } };
  assert.throws(() => parseSpec(bad), /undeclared attribute "y"/);
});

test("rejects condition values outside the domain", () => {
  const bad = { ...base, policies: { a: { rules: [{ when: { x: 5 }, effect: "permit" }] }, b: {} } };
  assert.throws(() => parseSpec(bad), /not in the domain of "x"/);
});

test("rejects empty and duplicate domains", () => {
  assert.throws(() => parseSpec({ ...base, attributes: [{ name: "x", domain: [] }] }), /non-empty "domain"/);
  assert.throws(() => parseSpec({ ...base, attributes: [{ name: "x", domain: [1, 1] }] }), /duplicate value/);
});

test("rejects duplicate attribute names", () => {
  const attrs = [{ name: "x", domain: [0] }, { name: "x", domain: [1] }];
  assert.throws(() => parseSpec({ ...base, attributes: attrs }), /duplicate attribute name "x"/);
});

test("requires exactly two policies", () => {
  assert.throws(() => parseSpec({ ...base, policies: { a: {} } }), /exactly two policies/);
  assert.throws(() => parseSpec({ ...base, policies: { a: {}, b: {}, c: {} } }), /exactly two policies/);
});

test("rejects unknown condition operators and empty in-lists", () => {
  const badOp = { ...base, policies: { a: { rules: [{ when: { x: { gt: 1 } }, effect: "permit" }] }, b: {} } };
  assert.throws(() => parseSpec(badOp), /unknown operator "gt"/);
  const badIn = { ...base, policies: { a: { rules: [{ when: { x: { in: [] } }, effect: "permit" }] }, b: {} } };
  assert.throws(() => parseSpec(badIn), /non-empty array/);
});

test("rejects a negative budget", () => {
  assert.throws(() => parseSpec({ ...base, budget: -1 }), /non-negative integer/);
});

test("parses eq/ne/in operators", () => {
  const spec = parseSpec({
    attributes: [{ name: "x", domain: [0, 1, 2] }],
    policies: {
      a: { rules: [{ when: { x: { ne: 0 } }, effect: "permit" }, { when: { x: { in: [1, 2] } }, effect: "deny" }] },
      b: {},
    },
  });
  assert.equal(spec.policies[0].rules[0]!.conditions[0]!.kind, "ne");
  assert.equal(spec.policies[0].rules[1]!.conditions[0]!.kind, "in");
});

test("SpecError is the error type for invalid specs", () => {
  assert.throws(() => parseSpec(null), (err: unknown) => err instanceof SpecError);
});
