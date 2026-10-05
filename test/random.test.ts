/**
 * Randomized exact verification on small integer LPs (deterministic seed).
 *
 *  - Suite A: 150 instances (up to 6 vars, 12 constraints). Every result's
 *    certificate (primal+dual / Farkas / point+ray) is verified exactly by
 *    the independent checker.
 *  - Suite B: 120 smaller instances cross-checked against exact vertex
 *    enumeration (an independent solving method sharing no pivoting code).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  solve,
  checkResult,
  normalize,
  toCanonical,
  solveByEnumeration,
  type LPInput,
  type Sense,
} from "../src/index.js";

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

function randInt(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

function randomLP(
  rnd: () => number,
  maxVars: number,
  maxCons: number,
  maxEqualities: number,
): LPInput {
  const numVars = randInt(rnd, 1, maxVars);
  const numCons = randInt(rnd, 1, maxCons);
  let equalities = 0;
  const constraints = [];
  for (let i = 0; i < numCons; i++) {
    let sense: Sense;
    const roll = rnd();
    if (roll < 0.45) sense = "<=";
    else if (roll < 0.85) sense = ">=";
    else if (equalities < maxEqualities) {
      sense = "=";
      equalities++;
    } else sense = "<=";
    constraints.push({
      coeffs: Array.from({ length: numVars }, () => randInt(rnd, -5, 5)),
      sense,
      rhs: randInt(rnd, -10, 10),
    });
  }
  return {
    numVars,
    objective: Array.from({ length: numVars }, () => randInt(rnd, -5, 5)),
    direction: rnd() < 0.5 ? "max" : "min",
    constraints,
  };
}

test("suite A: 150 random LPs, all certificates verify exactly", () => {
  const rnd = mulberry32(20261005);
  const counts = { optimal: 0, infeasible: 0, unbounded: 0 };
  for (let k = 0; k < 150; k++) {
    const p = randomLP(rnd, 6, 12, 2);
    const r = solve(p);
    counts[r.status]++;
    const check = checkResult(p, r);
    assert.ok(
      check.ok,
      `instance ${k}: certificate rejected: ${JSON.stringify(check)}\n` +
        `problem: ${JSON.stringify(p)}\nstatus: ${r.status}`,
    );
  }
  assert.ok(counts.optimal > 0, `no optimal instances: ${JSON.stringify(counts)}`);
  assert.ok(counts.infeasible > 0, `no infeasible instances: ${JSON.stringify(counts)}`);
  assert.ok(counts.unbounded > 0, `no unbounded instances: ${JSON.stringify(counts)}`);
});

test("suite B: 120 random small LPs, simplex matches vertex enumeration", () => {
  const rnd = mulberry32(0xC0FFEE);
  const counts = { optimal: 0, infeasible: 0, unbounded: 0 };
  for (let k = 0; k < 120; k++) {
    const p = randomLP(rnd, 4, 6, 1);
    const simplex = solve(p);
    counts[simplex.status]++;
    const lp = normalize(p);
    const enumResult = solveByEnumeration(toCanonical(lp));
    assert.notEqual(enumResult.status, "skipped", `instance ${k} skipped`);
    assert.equal(
      simplex.status,
      enumResult.status,
      `instance ${k}: status mismatch (simplex=${simplex.status}, enum=${enumResult.status})\n` +
        `problem: ${JSON.stringify(p)}`,
    );
    if (simplex.status === "optimal" && enumResult.status === "optimal") {
      const simplexVal = lp.flipped ? simplex.objectiveValue.neg() : simplex.objectiveValue;
      assert.ok(
        simplexVal.eq(enumResult.objectiveValue),
        `instance ${k}: value mismatch simplex=${simplexVal} enum=${enumResult.objectiveValue}\n` +
          `problem: ${JSON.stringify(p)}`,
      );
    }
    assert.deepEqual(checkResult(p, simplex), { ok: true }, `instance ${k} certificate`);
  }
  assert.ok(counts.optimal > 0, `no optimal instances: ${JSON.stringify(counts)}`);
  assert.ok(counts.infeasible > 0, `no infeasible instances: ${JSON.stringify(counts)}`);
  assert.ok(counts.unbounded > 0, `no unbounded instances: ${JSON.stringify(counts)}`);
});
