import assert from "node:assert/strict";
import { test } from "node:test";
import { decideTotal, isWitness, possibleEffects } from "../src/evaluate.js";
import { parseSpec } from "../src/spec.js";
import type { Policy } from "../src/types.js";

const policy: Policy = {
  name: "p",
  defaultEffect: "deny",
  rules: [
    { conditions: [{ kind: "eq", attr: "x", value: 1 }], effect: "permit" },
    { conditions: [{ kind: "eq", attr: "x", value: 1 }], effect: "deny" },
  ],
};

test("first matching rule wins", () => {
  assert.equal(decideTotal(policy, new Map([["x", 1]])), "permit");
});

test("default effect applies when no rule matches", () => {
  assert.equal(decideTotal(policy, new Map([["x", 0]])), "deny");
});

test("ne and in conditions", () => {
  const p: Policy = {
    name: "p",
    defaultEffect: "deny",
    rules: [
      { conditions: [{ kind: "ne", attr: "x", value: 0 }], effect: "permit" },
      { conditions: [{ kind: "in", attr: "x", values: [2, 3] }], effect: "permit" },
    ],
  };
  assert.equal(decideTotal(p, new Map([["x", 1]])), "permit");
  assert.equal(decideTotal(p, new Map([["x", 0]])), "deny");
});

test("possibleEffects is a singleton on a determining assignment", () => {
  assert.deepEqual([...possibleEffects(policy, new Map([["x", 1]]))], ["permit"]);
  assert.deepEqual([...possibleEffects(policy, new Map([["x", 0]]))], ["deny"]);
});

test("possibleEffects collects both outcomes when a condition is unknown", () => {
  assert.deepEqual([...possibleEffects(policy, new Map())].sort(), ["deny", "permit"]);
});

test("isWitness requires both policies determined and different", () => {
  const spec = parseSpec({
    attributes: [{ name: "x", domain: [0, 1] }],
    policies: {
      a: { rules: [{ when: { x: 1 }, effect: "permit" }] },
      b: {},
    },
  });
  assert.deepEqual(isWitness(spec.policies, new Map([["x", 1]])), ["permit", "deny"]);
  assert.equal(isWitness(spec.policies, new Map([["x", 0]])), false);
  assert.equal(isWitness(spec.policies, new Map()), false);
});
