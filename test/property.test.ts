import { test } from "node:test";
import assert from "node:assert/strict";
import { diff, normalize } from "../src/snapshot.js";
import {
  getAtPath,
  independentEqual,
  mulberry32,
  mutate,
  randomInt,
  randomJson,
  randomRules,
} from "./helpers.js";

const ITERATIONS = 500;

function makePairs(seed: number, n: number) {
  const rng = mulberry32(seed);
  const pairs: Array<{ a: ReturnType<typeof randomJson>; b: ReturnType<typeof randomJson> }> = [];
  for (let i = 0; i < n; i++) {
    const a = randomJson(rng);
    let b = a;
    const mutations = randomInt(rng, 0, 3);
    for (let m = 0; m < mutations; m++) b = mutate(rng, b);
    pairs.push({ a, b });
  }
  return pairs;
}

test("property: diff is empty iff the independent recursive comparator agrees", () => {
  for (const { a, b } of makePairs(20261006, ITERATIONS)) {
    const entries = diff(a, b);
    assert.equal(
      entries.length === 0,
      independentEqual(a, b),
      `diff/independentEqual disagree on ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    );
  }
});

test("property: every reported path is a real difference with both original values", () => {
  for (const { a, b } of makePairs(777, ITERATIONS)) {
    for (const entry of diff(a, b)) {
      const lhs = getAtPath(a, entry.path);
      const rhs = getAtPath(b, entry.path);
      assert.equal(
        lhs.found && rhs.found && independentEqual(lhs.value, rhs.value),
        false,
        `reported path ${entry.path} is not an actual difference`,
      );
      // Both sides' original values are carried on the entry.
      assert.ok(independentEqual(entry.expected, lhs.found ? lhs.value : undefined));
      assert.ok(independentEqual(entry.actual, rhs.found ? rhs.value : undefined));
    }
  }
});

test("property: normalization is idempotent for random JSON and random rules", () => {
  const rng = mulberry32(424242);
  for (let i = 0; i < ITERATIONS; i++) {
    const value = randomJson(rng);
    const rules = randomRules(rng, value, randomInt(rng, 0, 4));
    const once = normalize(value, rules);
    const twice = normalize(once, rules);
    assert.ok(independentEqual(once, twice), `not idempotent for rules ${JSON.stringify(rules)}`);
    assert.deepEqual(twice, once);
  }
});

test("property: normalize/diff consistency (ignored values vanish, structure remains)", () => {
  const rng = mulberry32(13579);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomJson(rng);
    let b = a;
    for (let m = 0, n = randomInt(rng, 0, 3); m < n; m++) b = mutate(rng, b);
    const rules = randomRules(rng, a, randomInt(rng, 0, 4));
    const entries = diff(a, b, { ignore: rules });
    const normalizedEqual = independentEqual(normalize(a, rules), normalize(b, rules));
    assert.equal(
      entries.length === 0,
      normalizedEqual,
      `normalize/diff disagree for rules ${JSON.stringify(rules)}`,
    );
  }
});

test("property: ignore rules never mask structural errors", () => {
  const rng = mulberry32(86420);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomJson(rng);
    let b = a;
    for (let m = 0, n = randomInt(rng, 0, 3); m < n; m++) b = mutate(rng, b);
    const rules = randomRules(rng, a, randomInt(rng, 0, 5));
    const baseline = diff(a, b);
    const withRules = diff(a, b, { ignore: rules });
    const structuralOf = (entries: typeof baseline) =>
      entries.filter((e) => e.kind === "structural").map((e) => e.path).sort();
    // The structural findings are identical with and without ignore rules.
    assert.deepEqual(structuralOf(withRules), structuralOf(baseline));
    // Rules can only remove entries, never add new ones.
    assert.ok(withRules.length <= baseline.length);
  }
});

test("property: ignoring all reported value paths leaves only structural entries", () => {
  for (const { a, b } of makePairs(31337, ITERATIONS)) {
    const baseline = diff(a, b);
    const valueRules = baseline.filter((e) => e.kind === "value").map((e) => e.path);
    const remaining = diff(a, b, { ignore: valueRules });
    assert.ok(remaining.every((e) => e.kind === "structural"));
    assert.deepEqual(
      remaining.map((e) => e.path).sort(),
      baseline.filter((e) => e.kind === "structural").map((e) => e.path).sort(),
    );
  }
});

test("property: ignoreArrayOrder agrees with order-insensitive normalization", () => {
  const rng = mulberry32(999331);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomJson(rng);
    let b = a;
    for (let m = 0, n = randomInt(rng, 0, 3); m < n; m++) b = mutate(rng, b);
    const rules = randomRules(rng, a, randomInt(rng, 0, 3));
    const opts = { ignore: rules, ignoreArrayOrder: true };
    const entries = diff(a, b, opts);
    const normalizedEqual = independentEqual(normalize(a, rules, opts), normalize(b, rules, opts));
    assert.equal(entries.length === 0, normalizedEqual);
  }
});
