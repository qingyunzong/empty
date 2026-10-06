/**
 * Shrunken-domain exhaustive verification (缩小域穷举核验).
 *
 * Random small systems are generated, solved with the exact solver, and
 * the resulting step intervals are compared against a brute-force
 * enumeration of every integer tuple in the (tiny) domains.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { floorMod } from "../src/bigintmath.js";
import { parseConstraint, type Constraint } from "../src/parser.js";
import { solveSystem, type Domain, type StepInterval } from "../src/solver.js";

/* deterministic PRNG so failures are reproducible */
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

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[randInt(rng, 0, items.length - 1)]!;
}

interface Case {
  vars: string[];
  domains: Map<string, Domain>;
  constraintTexts: string[];
  constraints: Constraint[];
}

function generateCase(rng: () => number): Case {
  const varNames = ["x", "y"];
  const nVars = randInt(rng, 1, 2);
  const vars = varNames.slice(0, nVars);
  const domains = new Map<string, Domain>();
  for (const v of vars) {
    const lo = randInt(rng, -25, 10);
    const hi = lo + randInt(rng, 0, 30);
    domains.set(v, { lo: BigInt(lo), hi: BigInt(hi) });
  }

  const constraintTexts: string[] = [];
  const nConstraints = randInt(rng, 1, 5);
  for (let i = 0; i < nConstraints; i++) {
    const v = pick(rng, vars);
    const a = randInt(rng, -6, 6);
    const b = randInt(rng, -15, 15);
    const c = randInt(rng, -20, 20);
    const expr = `((${a})*${v} + (${b}))`;
    const kind = randInt(rng, 0, 9);
    if (kind <= 4) {
      const op = pick(rng, ["<", "<=", ">", ">=", "=="] as const);
      constraintTexts.push(`${expr} ${op} (${c})`);
    } else if (kind <= 7) {
      const m = randInt(rng, 1, 12);
      const r = randInt(rng, -3, 14);
      constraintTexts.push(
        rng() < 0.5 ? `${expr} % ${m} == (${r})` : `${expr} == (${r}) (mod ${m})`,
      );
    } else {
      // constant-only constraint
      const op = pick(rng, ["<", "<=", ">", ">=", "=="] as const);
      constraintTexts.push(`(${b}) ${op} (${c})`);
    }
  }
  return {
    vars,
    domains,
    constraintTexts,
    constraints: constraintTexts.map(parseConstraint),
  };
}

function evalConstraint(c: Constraint, assignment: Map<string, bigint>): boolean {
  let value = c.expr.konst;
  for (const [v, coef] of c.expr.coefs) value += coef * assignment.get(v)!;
  switch (c.kind) {
    case "ineq":
      return value <= 0n;
    case "eq":
      return value === 0n;
    case "cong":
      return floorMod(value, c.modulus) === 0n;
  }
}

/** Brute-force: returns per-variable solution value sets, or null when unsat. */
function bruteForce(cs: Case): Map<string, Set<bigint>> | null {
  const v1 = cs.vars[0]!;
  const v2 = cs.vars.length > 1 ? cs.vars[1]! : null;
  const d1 = cs.domains.get(v1)!;
  const d2 = v2 === null ? null : cs.domains.get(v2)!;
  const out = new Map<string, Set<bigint>>(cs.vars.map((v) => [v, new Set<bigint>()]));
  let any = false;
  const check = (assignment: Map<string, bigint>): boolean =>
    cs.constraints.every((c) => evalConstraint(c, assignment));
  if (d2 === null) {
    for (let a = d1.lo; a <= d1.hi; a++) {
      if (check(new Map([[v1, a]]))) {
        any = true;
        out.get(v1)!.add(a);
      }
    }
  } else {
    for (let a = d1.lo; a <= d1.hi; a++) {
      for (let b = d2.lo; b <= d2.hi; b++) {
        const assignment = new Map<string, bigint>([
          [v1, a],
          [v2!, b],
        ]);
        if (check(assignment)) {
          any = true;
          out.get(v1)!.add(a);
          out.get(v2!)!.add(b);
        }
      }
    }
  }
  return any ? out : null;
}

function expand(s: StepInterval): Set<bigint> {
  const out = new Set<bigint>();
  for (let x = s.start; x <= s.end; x += s.step) out.add(x);
  return out;
}

test("solver output matches brute-force enumeration on shrunken domains", () => {
  const rng = mulberry32(0x5eed);
  const iterations = 1500;
  let satCount = 0;
  let unsatCount = 0;
  for (let i = 0; i < iterations; i++) {
    const cs = generateCase(rng);
    const expected = bruteForce(cs);
    const result = solveSystem(cs.domains, cs.constraints);
    const ctx = `case #${i}: ${JSON.stringify(cs.constraintTexts)} domains=${JSON.stringify(
      [...cs.domains.entries()],
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    )}`;

    if (expected === null) {
      assert.equal(result.status, "unsat", `expected UNSAT: ${ctx}`);
      unsatCount++;
      continue;
    }
    assert.equal(result.status, "sat", `expected SAT: ${ctx}`);
    if (result.status !== "sat") return;
    satCount++;
    for (const v of cs.vars) {
      const s = result.solutions.get(v)!;
      const want = expected.get(v)!;
      const got = expand(s);
      assert.deepEqual(got, want, `variable ${v}: ${ctx}`);
      // the step interval must be tight and minimal
      assert.equal(s.count, BigInt(want.size), `count for ${v}: ${ctx}`);
      assert.equal(s.start, [...want].reduce((p, q) => (p < q ? p : q)), `start ${v}: ${ctx}`);
      assert.equal(s.end, [...want].reduce((p, q) => (p > q ? p : q)), `end ${v}: ${ctx}`);
      assert.ok(s.step >= 1n);
    }
  }
  // sanity: the random suite must exercise both outcomes
  assert.ok(satCount > 100, `too few SAT cases: ${satCount}`);
  assert.ok(unsatCount > 100, `too few UNSAT cases: ${unsatCount}`);
});
