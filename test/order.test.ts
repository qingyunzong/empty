import assert from "node:assert/strict";
import { test } from "node:test";
import { enumeratePartial, spaceSize } from "../src/order.js";
import { parseSpec } from "../src/spec.js";

const spec = parseSpec({
  attributes: [
    { name: "x", domain: [0, 1] },
    { name: "y", domain: ["a", "b", "c"] },
  ],
  policies: { a: {}, b: {} },
});

test("spaceSize is the product of (domain size + 1)", () => {
  assert.equal(spaceSize(spec), 12n);
});

test("enumeration: fewest specified fields, then subsets, then value order", () => {
  const seen = [...enumeratePartial(spec)].map((a) => Object.fromEntries(a));
  assert.deepEqual(seen, [
    {},
    { x: 0 },
    { x: 1 },
    { y: "a" },
    { y: "b" },
    { y: "c" },
    { x: 0, y: "a" },
    { x: 0, y: "b" },
    { x: 0, y: "c" },
    { x: 1, y: "a" },
    { x: 1, y: "b" },
    { x: 1, y: "c" },
  ]);
});

test("enumeration with zero attributes yields only the empty assignment", () => {
  const empty = parseSpec({ attributes: [], policies: { a: {}, b: {} } });
  assert.equal(spaceSize(empty), 1n);
  assert.deepEqual([...enumeratePartial(empty)].map((a) => Object.fromEntries(a)), [{}]);
});
