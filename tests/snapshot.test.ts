import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  diff,
  formatDiffs,
  formatPath,
  IGNORED_PLACEHOLDER,
  MISSING,
  normalize,
  parseRule,
} from "../src/index.js";
import {
  containsPlaceholder,
  deepEqualIndependent,
  makeRng,
  mutate,
  randomJson,
  randomRules,
} from "./helpers.js";

test("path rules: parse and format", () => {
  assert.deepEqual(parseRule("meta.updatedAt"), ["meta", "updatedAt"]);
  assert.deepEqual(parseRule("items[0].id"), ["items", 0, "id"]);
  assert.deepEqual(parseRule("users[*].token"), ["users", "*", "token"]);
  assert.deepEqual(parseRule("$.a.0.b"), ["a", 0, "b"]);
  assert.equal(formatPath(["a", 0, "b"]), "$.a[0].b");
  assert.equal(formatPath([]), "$");
  assert.throws(() => parseRule("a..b"));
  assert.throws(() => parseRule("a["));
});

test("ignore rules exempt volatile values, arrays keep order", () => {
  const expected = { id: 1, ts: 111, items: [{ sku: "a", ts: 1 }, { sku: "b", ts: 2 }] };
  const actual = { id: 1, ts: 999, items: [{ sku: "a", ts: 10 }, { sku: "b", ts: 20 }] };
  const result = diff(expected, actual, ["ts", "items[*].ts"]);
  assert.equal(result.equal, true);
  assert.deepEqual(result.diffs, []);
  assert.deepEqual(result.unusedRules, []);
});

test("array order is significant by default", () => {
  const result = diff({ a: [1, 2, 3] }, { a: [3, 2, 1] });
  assert.equal(result.equal, false);
  assert.deepEqual(
    result.diffs.map((d) => [d.path, d.expected, d.actual]),
    [
      ["$.a[0]", 1, 3],
      ["$.a[2]", 3, 1],
    ],
  );
});

test("ignore rules never mask structural errors", () => {
  // Missing key at an ignored path is still reported.
  const missing = diff({ a: { ts: 1, keep: 2 } }, { a: { keep: 2 } }, ["a.ts"]);
  assert.equal(missing.equal, false);
  assert.deepEqual(missing.diffs, [
    { path: "$.a.ts", reason: "missing-key", expected: 1, actual: MISSING },
  ]);

  // Unexpected key is structural too.
  const extra = diff({ a: { keep: 2 } }, { a: { keep: 2, ts: 9 } }, ["a.ts"]);
  assert.equal(extra.equal, false);
  assert.deepEqual(extra.diffs, [
    { path: "$.a.ts", reason: "unexpected-key", expected: MISSING, actual: 9 },
  ]);

  // Array length mismatch under a wildcard rule is still reported.
  const len = diff({ items: [{ ts: 1 }] }, { items: [{ ts: 9 }, { ts: 8 }] }, ["items[*].ts"]);
  assert.equal(len.equal, false);
  assert.deepEqual(len.diffs, [
    { path: "$.items", reason: "array-length", expected: 1, actual: 2 },
  ]);
});

test("minimal diff paths carry both original values", () => {
  const expected = { user: { name: "ann", roles: ["r1", "r2"] }, n: 1 };
  const actual = { user: { name: "bob", roles: ["r1", "r2"] }, n: 1 };
  const result = diff(expected, actual);
  assert.deepEqual(result.diffs, [
    { path: "$.user.name", reason: "value", expected: "ann", actual: "bob" },
  ]);
  const report = formatDiffs(result);
  assert.ok(report.includes("$.user.name"));
  assert.ok(report.includes('"ann"'));
  assert.ok(report.includes('"bob"'));
});

test("type mismatch is reported at the exact path", () => {
  const result = diff({ a: { b: 1 } }, { a: [1] });
  assert.deepEqual(result.diffs, [
    { path: "$.a", reason: "type", expected: { b: 1 }, actual: [1] },
  ]);
});

test("unused rules are surfaced", () => {
  const result = diff({ a: 1 }, { a: 1 }, ["a", "ghost.path"]);
  assert.equal(result.equal, true);
  assert.deepEqual(result.unusedRules, ["ghost.path"]);
});

test("normalize replaces ignored subtrees and never mutates input", () => {
  const input = { ts: 123, nested: { id: "x", keep: [1, 2] } };
  const frozen = structuredClone(input);
  const used = new Set<number>();
  const out = normalize(input, ["ts", "nested.id"], used);
  assert.deepEqual(out, { ts: IGNORED_PLACEHOLDER, nested: { id: IGNORED_PLACEHOLDER, keep: [1, 2] } });
  assert.deepEqual(input, frozen);
  assert.deepEqual([...used].sort(), [0, 1]);
});

test("normalize is idempotent", () => {
  const input = { a: { b: [1, { c: 2 }] }, d: "x" };
  const rules = ["a.b[*].c", "d"];
  const once = normalize(input, rules);
  const twice = normalize(once, rules);
  assert.deepEqual(twice, once);
});

test("property: normalization idempotent + comparator agrees with independent recursion", () => {
  const ITERATIONS = 500;
  for (let seed = 1; seed <= ITERATIONS; seed += 1) {
    const rng = makeRng(seed);
    const value = randomJson(rng);
    assert.equal(containsPlaceholder(value), false, `seed ${seed}: placeholder collision`);
    const rules = randomRules(rng, value);

    // Idempotency on random JSON.
    const once = normalize(value, rules);
    const twice = normalize(once, rules);
    assert.ok(deepEqualIndependent(once, twice), `seed ${seed}: normalize not idempotent`);

    // Cross-check diff() against independent recursion over normalized values.
    const other = mutate(rng, value);
    const usedA = new Set<number>();
    const usedB = new Set<number>();
    const normA = normalize(value, rules, usedA);
    const normB = normalize(other, rules, usedB);
    const expected = deepEqualIndependent(normA, normB);
    const result = diff(value, other, rules);
    assert.equal(
      result.equal,
      expected,
      `seed ${seed}: mismatch\nrules=${JSON.stringify(rules)}\nvalue=${JSON.stringify(value)}\nother=${JSON.stringify(other)}\n${formatDiffs(result)}`,
    );

    // Rule usage cross-check: diff() only marks rules that matched a path
    // present on both sides, so its used set is always a subset of the
    // normalize() union; when values compare equal (identical structure,
    // fully walked) the two must agree exactly.
    const usedUnion = new Set([...usedA, ...usedB]);
    const unionUnused = rules.filter((_, i) => !usedUnion.has(i));
    for (const rule of unionUnused) {
      assert.ok(result.unusedRules.includes(rule), `seed ${seed}: rule ${rule} usage disagrees`);
    }
    if (result.equal) {
      assert.deepEqual(result.unusedRules, unionUnused, `seed ${seed}: unused rules disagree`);
    }
  }
});

test("property: identical values are always equal under any rules", () => {
  for (let seed = 1000; seed < 1200; seed += 1) {
    const rng = makeRng(seed);
    const value = randomJson(rng);
    const rules = randomRules(rng, value);
    assert.equal(diff(value, structuredClone(value), rules).equal, true, `seed ${seed}`);
  }
});
