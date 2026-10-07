import { test } from "node:test";
import assert from "node:assert/strict";
import {
  E,
  Expr,
  FormSchema,
  compileSchema,
  computeVisibility,
  enumerateFixpoints,
  verifyWithTruthTable,
} from "../src/index";

test("hand-built schemas match the finite truth table", () => {
  const schemas: FormSchema[] = [
    {
      fields: [
        { name: "a", when: E.filled("b") },
        { name: "b", when: E.filled("a") },
      ],
    },
    {
      fields: [
        { name: "a", when: E.or(E.filled("b"), E.const(true)) },
        { name: "b", when: E.filled("a") },
        { name: "c", when: E.and(E.filled("a"), E.filled("b")) },
      ],
    },
    {
      fields: [
        { name: "x" },
        { name: "y", when: E.eq("x", 1) },
        { name: "z", when: E.or(E.filled("y"), E.eq("x", 2)) },
        { name: "w", when: E.and(E.filled("z"), E.filled("y")) },
      ],
    },
  ];
  for (const schema of schemas) {
    for (const values of [{}, { a: 1, b: 2 }, { x: 1 }, { x: 2 }, { x: 3 }]) {
      const v = verifyWithTruthTable(schema, values);
      assert.ok(v.ok, v.detail);
    }
  }
});

test("multiple fixpoints exist for mutual recursion; iteration picks the least", () => {
  // a <-> b mutual dependency: both {} and {a,b} are fixpoints of the
  // one-step operator, but monotone iteration from all-hidden yields {}.
  const schema: FormSchema = {
    fields: [
      { name: "a", when: E.filled("b") },
      { name: "b", when: E.filled("a") },
    ],
  };
  const fixpoints = enumerateFixpoints(schema, { a: 1, b: 1 });
  assert.equal(fixpoints.length, 2);
  const computed = computeVisibility(schema, { a: 1, b: 1 }).visible;
  assert.deepEqual(computed, []);
  const v = verifyWithTruthTable(schema, { a: 1, b: 1 });
  assert.ok(v.ok, v.detail);
  assert.ok(v.isFixpoint);
  assert.ok(v.isLeast);
});

/** Deterministic PRNG (mulberry32) for reproducible fuzzing. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a random monotone expression over the given fields. */
function randomExpr(rand: () => number, fields: string[], depth: number): Expr {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const field = () => pick(fields);
  if (depth <= 0) {
    return pick([
      () => E.filled(field()),
      () => E.value(field()),
      () => E.eq(field(), pick([0, 1, true, false, "x"])),
      () => E.cmp(pick(["<", "<=", ">", ">="] as const), field(), Math.floor(rand() * 3)),
      () => E.const(rand() < 0.5),
    ])();
  }
  const n = 1 + Math.floor(rand() * 3);
  const args = Array.from({ length: n }, () => randomExpr(rand, fields, depth - 1));
  return rand() < 0.5 ? E.and(...args) : E.or(...args);
}

/** Enumerate the finite truth table of values: each field in {undefined, 0, 1, true, false}. */
function* valueAssignments(fields: string[]): Generator<Record<string, unknown>> {
  const domain: unknown[] = [undefined, 0, 1, true, false];
  const total = Math.pow(domain.length, fields.length);
  for (let i = 0; i < total; i++) {
    let n = i;
    const values: Record<string, unknown> = {};
    for (const f of fields) {
      values[f] = domain[n % domain.length];
      n = Math.floor(n / domain.length);
    }
    yield values;
  }
}

test("fuzz: random monotone schemas verified against the finite truth table", () => {
  const rand = rng(20261007);
  for (let trial = 0; trial < 40; trial++) {
    const fieldCount = 2 + Math.floor(rand() * 3); // 2..4 fields -> <= 16 assignments, 5^4 value combos
    const names = Array.from({ length: fieldCount }, (_, i) => `f${i}`);
    const schema: FormSchema = {
      fields: names.map((name) => ({ name, when: randomExpr(rand, names, 2) })),
    };
    const compiled = compileSchema(schema); // throws if non-monotone (must not happen)
    for (const values of valueAssignments(names)) {
      const v = verifyWithTruthTable(compiled, values);
      assert.ok(v.ok, `trial ${trial} values=${JSON.stringify(values)}: ${v.detail}`);
    }
  }
});

test("fuzz: visibility grows monotonically across rounds", () => {
  const rand = rng(42);
  for (let trial = 0; trial < 40; trial++) {
    const names = ["a", "b", "c", "d"];
    const schema: FormSchema = {
      fields: names.map((name) => ({ name, when: randomExpr(rand, names, 2) })),
    };
    const res = computeVisibility(schema, { a: 1, b: 0, c: true, d: "x" });
    const seen = new Set<string>();
    for (const round of res.rounds) {
      for (const name of round.becameVisible) {
        assert.ok(!seen.has(name), `field ${name} appeared twice`);
        seen.add(name);
      }
    }
    assert.deepEqual([...seen].sort(), [...res.visible].sort());
  }
});
