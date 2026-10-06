import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.js";
import { bruteForce, solve, type LiquidInput } from "../src/solver.js";

// Deterministic PRNG so the verification is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Enumerate every amount vector of length n with sum <= maxTotal, in lexicographic order. */
function* allVectors(n: number, maxTotal: number): Generator<number[]> {
  const v = new Array<number>(n).fill(0);
  function* rec(i: number, remaining: number): Generator<number[]> {
    if (i === n) {
      yield v.slice();
      return;
    }
    for (let x = 0; x <= remaining; x++) {
      v[i] = x;
      yield* rec(i + 1, remaining - x);
    }
    v[i] = 0;
  }
  yield* rec(0, maxTotal);
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

interface RefSolution {
  amounts: number[];
  cost: bigint;
  total: number;
  concentration: Rational;
}

/** Independent reference: literally checks every vector in the domain. */
function reference(
  liquids: readonly LiquidInput[],
  lo: Rational,
  hi: Rational,
  maxTotal: number,
): RefSolution | null {
  let best: RefSolution | null = null;
  for (const v of allVectors(liquids.length, maxTotal)) {
    let total = 0;
    let sum = Rational.of(0n);
    let cost = 0n;
    for (let i = 0; i < v.length; i++) {
      total += v[i];
      sum = sum.add(liquids[i].concentration.mul(Rational.of(BigInt(v[i]))));
      cost += liquids[i].cost * BigInt(v[i]);
    }
    if (total < 1) continue;
    const concentration = sum.div(Rational.of(BigInt(total)));
    if (concentration.lt(lo) || concentration.gt(hi)) continue;
    if (
      best === null ||
      cost < best.cost ||
      (cost === best.cost && lexLess(v, best.amounts))
    ) {
      best = { amounts: v, cost, total, concentration };
    }
  }
  return best;
}

function checkCase(
  liquids: readonly LiquidInput[],
  lo: Rational,
  hi: Rational,
  maxTotal: number,
): void {
  const expected = reference(liquids, lo, hi, maxTotal);
  for (const [label, fn] of [
    ["solve", solve],
    ["bruteForce", bruteForce],
  ] as const) {
    const res = fn(liquids, lo, hi, maxTotal);
    if (expected === null) {
      assert.equal(res.status, "infeasible", `${label} should prove infeasibility`);
      assert.equal(res.solution, null);
    } else {
      assert.equal(res.status, "optimal", `${label} should find the optimum`);
      const sol = res.solution!;
      assert.deepEqual(sol.amounts, expected.amounts, `${label} vector mismatch`);
      assert.equal(sol.cost, expected.cost, `${label} cost mismatch`);
      assert.equal(sol.total, expected.total, `${label} total mismatch`);
      assert.ok(
        sol.concentration.eq(expected.concentration),
        `${label} concentration ${sol.concentration} != ${expected.concentration}`,
      );
    }
  }
}

test("exhaustive small-domain verification against full vector enumeration", () => {
  const rand = mulberry32(20241007);
  const pick = (arr: number[]): number => arr[Math.floor(rand() * arr.length)];
  const cases = 400;
  for (let t = 0; t < cases; t++) {
    const n = 1 + Math.floor(rand() * 4); // 1..4 liquids
    const maxTotal = 1 + Math.floor(rand() * 8); // 1..8
    const liquids: LiquidInput[] = [];
    for (let i = 0; i < n; i++) {
      const num = Math.floor(rand() * 7); // 0..6
      const den = 1 + Math.floor(rand() * 6); // 1..6
      liquids.push({
        name: `l${i}`,
        concentration: Rational.of(BigInt(num), BigInt(den)),
        cost: BigInt(Math.floor(rand() * 10)),
      });
    }
    const a = Rational.of(BigInt(pick([0, 1, 2, 3, 4])), BigInt(pick([1, 2, 3, 4, 5, 6])));
    const b = Rational.of(BigInt(pick([0, 1, 2, 3, 4, 5])), BigInt(pick([1, 2, 3, 4, 5, 6])));
    const lo = a.le(b) ? a : b;
    let hi = a.le(b) ? b : a;
    if (rand() < 0.2) hi = lo; // sometimes a single-point target
    checkCase(liquids, lo, hi, maxTotal);
  }
});

test("structured edge cases verified against full enumeration", () => {
  const l = (c: string, cost: number): LiquidInput => ({
    name: c,
    concentration: Rational.parse(c),
    cost: BigInt(cost),
  });
  // All concentrations identical: only that exact value can ever be hit.
  checkCase([l("1/3", 2), l("1/3", 3), l("1/3", 1)], Rational.parse("1/3"), Rational.parse("1/3"), 6);
  checkCase([l("1/3", 2), l("1/3", 3)], Rational.parse("0"), Rational.parse("1/4"), 6);
  // Endpoint-only feasibility.
  checkCase([l("0", 1), l("1", 1)], Rational.parse("0"), Rational.parse("0"), 5);
  checkCase([l("0", 1), l("1", 1)], Rational.parse("1"), Rational.parse("1"), 5);
  // Zero costs everywhere.
  checkCase([l("1/4", 0), l("1/2", 0), l("3/4", 0)], Rational.parse("1/3"), Rational.parse("2/3"), 7);
  // Single liquid.
  checkCase([l("2/5", 3)], Rational.parse("2/5"), Rational.parse("2/5"), 4);
  checkCase([l("2/5", 3)], Rational.parse("3/5"), Rational.parse("1"), 4);
});
