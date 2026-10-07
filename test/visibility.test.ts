import { test } from "node:test";
import assert from "node:assert/strict";
import {
  E,
  applyBatch,
  compileSchema,
  computeVisibility,
  FormSchema,
} from "../src/index";

test("hidden fields are treated as unfilled", () => {
  const schema: FormSchema = {
    fields: [
      { name: "a", when: E.const(true) },
      { name: "b", when: E.filled("a") },
      { name: "c", when: E.filled("b") },
    ],
  };
  // a has no value -> b's condition false -> b hidden -> c sees b as unfilled.
  const res = computeVisibility(schema, {});
  assert.deepEqual(res.visible, ["a"]);
  assert.deepEqual(res.hidden, ["b", "c"]);
});

test("chained dependencies resolve over successive rounds", () => {
  const schema: FormSchema = {
    fields: [
      { name: "a", when: E.const(true) },
      { name: "b", when: E.filled("a") },
      { name: "c", when: E.filled("b") },
      { name: "d", when: E.and(E.filled("c"), E.eq("a", 1)) },
    ],
  };
  const res = computeVisibility(schema, { a: 1, b: 2, c: 3 });
  assert.deepEqual(res.visible, ["a", "b", "c", "d"]);
  assert.deepEqual(
    res.rounds.map((r) => [r.round, r.becameVisible]),
    [
      [1, ["a"]],
      [2, ["b"]],
      [3, ["c"]],
      [4, ["d"]],
    ],
  );
});

test("mutual circular dependency stays hidden (least fixpoint from all-hidden)", () => {
  const schema: FormSchema = {
    fields: [
      { name: "a", when: E.filled("b") },
      { name: "b", when: E.filled("a") },
    ],
  };
  const res = computeVisibility(schema, { a: 1, b: 2 });
  assert.deepEqual(res.visible, []);
  assert.deepEqual(res.rounds, []);
});

test("circular dependency with a seed resolves in rounds", () => {
  const schema: FormSchema = {
    fields: [
      { name: "a", when: E.or(E.filled("b"), E.eq("seed", "go")) },
      { name: "b", when: E.filled("a") },
      { name: "seed", when: E.const(true) },
    ],
  };
  const res = computeVisibility(schema, { seed: "go", a: 1, b: 2 });
  assert.deepEqual(res.visible, ["a", "b", "seed"]);
  assert.deepEqual(
    res.rounds.map((r) => r.becameVisible),
    [["seed"], ["a"], ["b"]],
  );
});

test("self-referential condition never becomes visible without a seed", () => {
  const schema: FormSchema = {
    fields: [{ name: "a", when: E.or(E.filled("a"), E.const(false)) }],
  };
  const res = computeVisibility(schema, { a: 1 });
  assert.deepEqual(res.visible, []);
});

test("value comparisons and boolean operators", () => {
  const schema: FormSchema = {
    fields: [
      { name: "age", when: E.const(true) },
      { name: "adult", when: E.cmp(">=", "age", 18) },
      { name: "senior", when: E.and(E.cmp(">=", "age", 65), E.value("age")) },
      { name: "teen", when: E.and(E.cmp(">=", "age", 13), E.not(E.const(false))) },
    ],
  };
  assert.deepEqual(computeVisibility(schema, { age: 70 }).visible, [
    "age",
    "adult",
    "senior",
    "teen",
  ]);
  assert.deepEqual(computeVisibility(schema, { age: 20 }).visible, ["age", "adult", "teen"]);
  assert.deepEqual(computeVisibility(schema, { age: 5 }).visible, ["age"]);
  assert.deepEqual(computeVisibility(schema, {}).visible, ["age"]);
});

test("batch update is atomic and reports visibility diff", () => {
  const schema: FormSchema = {
    fields: [
      { name: "x", when: E.const(true) },
      { name: "y", when: E.const(true) },
      { name: "both", when: E.and(E.filled("x"), E.filled("y")) },
      { name: "sum", when: E.filled("both") },
    ],
  };
  const compiled = compileSchema(schema);

  // First batch: only x. "both" must NOT appear even transiently.
  const s1 = applyBatch(compiled, null, { x: 1 });
  assert.deepEqual(s1.visible, ["x", "y"]);
  assert.deepEqual(s1.becameVisible, ["x", "y"]);
  assert.deepEqual(s1.becameHidden, []);

  // Second batch: y and both arrive; both + sum appear in one atomic step.
  const s2 = applyBatch(compiled, { values: s1.values, result: s1 }, { y: 2, both: "set" });
  assert.deepEqual(s2.values, { x: 1, y: 2, both: "set" });
  assert.deepEqual(s2.visible, ["x", "y", "both", "sum"]);
  assert.deepEqual(s2.becameVisible, ["both", "sum"]);
  assert.deepEqual(
    s2.rounds.map((r) => r.becameVisible),
    [["x", "y"], ["both"], ["sum"]],
  );

  // Third batch: x cleared -> both and sum disappear atomically.
  const s3 = applyBatch(compiled, { values: s2.values, result: s2 }, { x: undefined });
  assert.deepEqual(s3.visible, ["x", "y"]);
  assert.deepEqual(s3.becameHidden, ["both", "sum"]);
  assert.deepEqual(s3.becameVisible, []);
});

test("batch of interdependent values applies as one step", () => {
  const schema: FormSchema = {
    fields: [
      { name: "p", when: E.const(true) },
      { name: "q", when: E.eq("p", "on") },
      { name: "r", when: E.eq("q", "yes") },
    ],
  };
  // p and q set in the SAME batch: r becomes visible in the same atomic update.
  const res = applyBatch(schema, null, { p: "on", q: "yes" });
  assert.deepEqual(res.visible, ["p", "q", "r"]);
  assert.deepEqual(
    res.rounds.map((r) => r.becameVisible),
    [["p"], ["q"], ["r"]],
  );
});
