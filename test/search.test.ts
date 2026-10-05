import assert from "node:assert/strict";
import { test } from "node:test";
import { search } from "../src/search.js";
import { parseSpec } from "../src/spec.js";

function makeSpec(raw: unknown) {
  return parseSpec(raw);
}

const differSpec = () =>
  makeSpec({
    attributes: [
      { name: "role", domain: ["admin", "user"] },
      { name: "mfa", domain: [false, true] },
    ],
    policies: {
      a: { rules: [{ when: { role: "admin" }, effect: "permit" }] },
      b: {},
    },
  });

test("finds the witness with the fewest specified fields", () => {
  const result = search(differSpec());
  assert.equal(result.verdict, "DIFFER");
  assert.deepEqual(Object.fromEntries(result.witness!), { role: "admin" });
  assert.deepEqual(result.decisions, ["permit", "deny"]);
  assert.equal(result.checked, 2); // {} then {role:"admin"}
  assert.equal(result.space, 9n);
});

test("breaks ties by field value order", () => {
  const spec = makeSpec({
    attributes: [{ name: "role", domain: ["admin", "user"] }],
    policies: {
      a: { rules: [{ when: { role: "user" }, effect: "permit" }] },
      b: {},
    },
  });
  const result = search(spec);
  assert.equal(result.verdict, "DIFFER");
  assert.deepEqual(Object.fromEntries(result.witness!), { role: "user" });
  assert.equal(result.checked, 3); // {}, {role:"admin"}, {role:"user"}
});

test("attribute subsets are tried in declaration order", () => {
  const spec = makeSpec({
    attributes: [
      { name: "a1", domain: [0, 1] },
      { name: "a2", domain: [0, 1] },
    ],
    policies: {
      a: { rules: [{ when: { a2: 1 }, effect: "permit" }] },
      b: {},
    },
  });
  const result = search(spec);
  assert.equal(result.verdict, "DIFFER");
  assert.deepEqual(Object.fromEntries(result.witness!), { a2: 1 });
  assert.equal(result.checked, 5); // {}, {a1:0}, {a1:1}, {a2:0}, {a2:1}
});

test("equivalent policies give an exhaustive EQUIVALENT verdict", () => {
  const spec = makeSpec({
    attributes: [{ name: "x", domain: [0, 1] }],
    policies: {
      a: { rules: [{ when: { x: 0 }, effect: "permit" }] },
      b: { rules: [{ when: { x: 0 }, effect: "permit" }] },
    },
  });
  const result = search(spec);
  assert.equal(result.verdict, "EQUIVALENT");
  assert.equal(result.checked, 3);
  assert.equal(result.space, 3n);
});

test("budget exhaustion gives UNDECIDED", () => {
  const spec = makeSpec({
    attributes: [
      { name: "x", domain: [0, 1] },
      { name: "y", domain: [0, 1] },
    ],
    policies: {
      a: { rules: [{ when: { x: 1, y: 1 }, effect: "permit" }] },
      b: {},
    },
  });
  const result = search(spec, 2);
  assert.equal(result.verdict, "UNDECIDED");
  assert.equal(result.checked, 2);
  assert.equal(result.space, 9n);
});

test("budget of zero is immediately UNDECIDED", () => {
  const result = search(differSpec(), 0);
  assert.equal(result.verdict, "UNDECIDED");
  assert.equal(result.checked, 0);
});

test("budget covering the whole space still proves EQUIVALENT", () => {
  const spec = makeSpec({
    attributes: [{ name: "x", domain: [0, 1] }],
    policies: { a: {}, b: {} },
  });
  assert.equal(search(spec, 3).verdict, "EQUIVALENT");
  assert.equal(search(spec, 2).verdict, "UNDECIDED");
});

test("budget exactly reaching the witness still reports DIFFER", () => {
  assert.equal(search(differSpec(), 2).verdict, "DIFFER");
  assert.equal(search(differSpec(), 1).verdict, "UNDECIDED");
});

test("spec-level budget is honoured", () => {
  const spec = makeSpec({
    attributes: [{ name: "x", domain: [0, 1] }],
    budget: 1,
    policies: { a: {}, b: {} },
  });
  const result = search(spec);
  assert.equal(result.verdict, "UNDECIDED");
  assert.equal(result.checked, 1);
});
