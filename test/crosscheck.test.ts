import { test } from "node:test";
import assert from "node:assert/strict";
import type { Ast } from "../src/ast.js";
import { parse } from "../src/parser.js";
import { print } from "../src/print.js";
import {
  evaluate,
  evaluateTyped,
  recheck,
  quantityEqual,
  type Quantity,
} from "../src/evaluate.js";
import { dimsToUnitString } from "../src/dims.js";
import { Rational } from "../src/rational.js";
import { lookupUnit } from "../src/units.js";
import { UnitError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Small syntax-tree generation: an exhaustive enumeration of tiny trees plus
// seeded random deeper ones. Every generated tree is cross-checked four ways:
//   1. evaluate(ast)                     — direct evaluation
//   2. evaluate(parse(print(ast)))       — print/parse round trip
//   3. recheck(evaluateTyped(ast))       — typed-tree recomputation
//   4. recheck(evaluateTyped(parsed))    — typed tree of the round-tripped AST
// All four must agree on the quantity, or agree on the error. Successful
// quantities must also survive a canonical-unit-string round trip.
// ---------------------------------------------------------------------------

const ZERO = { start: 0, end: 0 };

function numLeaf(value: Rational): Ast {
  return { kind: "num", value, ...ZERO };
}

function unitLeaf(name: string): Ast {
  const def = lookupUnit(name);
  if (def === undefined) throw new Error(`bad test unit ${name}`);
  return { kind: "unit", name, def, ...ZERO };
}

const LEAVES: Ast[] = [
  numLeaf(Rational.of(0)),
  numLeaf(Rational.of(1)),
  numLeaf(Rational.of(2)),
  numLeaf(Rational.of(1, 2)),
  unitLeaf("m"),
  unitLeaf("s"),
  unitLeaf("kg"),
];

const OPS = ["+", "-", "*", "/"] as const;

function* unaryOver(base: readonly Ast[]): Generator<Ast> {
  for (const b of base) {
    yield { kind: "neg", expr: b, ...ZERO };
    yield { kind: "pow", base: b, exp: 2, ...ZERO };
    yield { kind: "pow", base: b, exp: -1, ...ZERO };
  }
}

function* enumerateSmallTrees(): Generator<Ast> {
  const level1: Ast[] = [...LEAVES, ...unaryOver(LEAVES)];
  yield* level1;
  for (const op of OPS) {
    for (const left of level1) {
      for (const right of level1) {
        yield { kind: "bin", op, left, right, ...ZERO };
      }
    }
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAND_UNITS = ["m", "s", "kg", "km", "min", "N", "J", "L", "Hz"];

function randomTree(rand: () => number, depth: number): Ast {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  if (depth === 0) {
    return rand() < 0.5
      ? numLeaf(Rational.of(Math.floor(rand() * 5)))
      : unitLeaf(pick(RAND_UNITS));
  }
  const choice = rand();
  if (choice < 0.15) return { kind: "neg", expr: randomTree(rand, depth - 1), ...ZERO };
  if (choice < 0.3) {
    return {
      kind: "pow",
      base: randomTree(rand, depth - 1),
      exp: pick([-2, -1, 2, 3] as const),
      ...ZERO,
    };
  }
  return {
    kind: "bin",
    op: pick(OPS),
    left: randomTree(rand, depth - 1),
    right: randomTree(rand, depth - 1),
    ...ZERO,
  };
}

interface Outcome {
  quantity?: Quantity;
  error?: Error;
}

function run(fn: () => Quantity): Outcome {
  try {
    return { quantity: fn() };
  } catch (e) {
    return { error: e as Error };
  }
}

function assertSameError(a: Error, b: Error, what: string): void {
  assert.equal(a.name, b.name, `${what}: error class differs (${a} vs ${b})`);
  if (a instanceof UnitError && b instanceof UnitError) {
    assert.equal(a.left.unit, b.left.unit, `${what}: left unit differs`);
    assert.equal(a.right.unit, b.right.unit, `${what}: right unit differs`);
  } else {
    // Source ranges legitimately differ between the synthetic tree (0..0)
    // and the reparsed round-trip tree; compare messages without them.
    const strip = (m: string): string => m.replace(/ at \d+\.\.\d+$/, "");
    assert.equal(strip(a.message), strip(b.message), `${what}: error message differs`);
  }
}

function crossCheck(ast: Ast, label: string): void {
  const src = print(ast);
  const parsed = parse(src);

  const direct = run(() => evaluate(ast));
  const roundTrip = run(() => evaluate(parsed));
  const typedDirect = run(() => recheck(evaluateTyped(ast)));
  const typedRoundTrip = run(() => recheck(evaluateTyped(parsed)));

  const all = [direct, roundTrip, typedDirect, typedRoundTrip];
  const failed = all.filter((o) => o.error !== undefined);

  if (failed.length > 0) {
    assert.equal(
      failed.length,
      4,
      `${label}: only some evaluation paths failed for ${src}: ` +
        all.map((o) => (o.error ? `${o.error.name}: ${o.error.message}` : "ok")).join(" | "),
    );
    assertSameError(direct.error!, roundTrip.error!, `${label} direct-vs-roundtrip`);
    assertSameError(direct.error!, typedDirect.error!, `${label} direct-vs-typed`);
    assertSameError(direct.error!, typedRoundTrip.error!, `${label} direct-vs-typed-roundtrip`);
    return;
  }

  const q = direct.quantity!;
  for (const [i, o] of all.entries()) {
    assert.ok(
      quantityEqual(q, o.quantity!),
      `${label}: path ${i} disagrees for ${src}`,
    );
  }

  // Canonical unit string round trip: parsing the canonical unit must
  // reproduce the same dimension vector.
  const canonical = dimsToUnitString(q.dims);
  const reparsed = evaluate(parse(canonical));
  assert.ok(
    quantityEqual(
      { value: Rational.ONE, dims: q.dims },
      { value: reparsed.value, dims: reparsed.dims },
    ),
    `${label}: canonical unit '${canonical}' does not round-trip`,
  );
}

test("cross-check: exhaustive enumeration of small syntax trees", () => {
  let count = 0;
  for (const ast of enumerateSmallTrees()) {
    crossCheck(ast, `tree#${count}`);
    count += 1;
  }
  assert.ok(count > 3000, `expected many trees, got ${count}`);
});

test("cross-check: seeded random deeper trees", () => {
  const rand = mulberry32(20261005);
  for (let i = 0; i < 300; i += 1) {
    crossCheck(randomTree(rand, 4), `random#${i}`);
  }
});
