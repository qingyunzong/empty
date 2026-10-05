import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluator.ts';
import { evaluateExact } from '../src/interpreter.ts';
import { BudgetError } from '../src/errors.ts';

/** Deterministic PRNG (mulberry32) so the generated cases are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGenerator(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const int = (n: number): number => Math.floor(rnd() * n);

  function genScalar(depth: number): string {
    if (depth <= 0) return String(int(21));
    switch (int(8)) {
      case 0:
      case 1:
        return String(int(21));
      case 2:
        return `(${genScalar(depth - 1)} + ${genScalar(depth - 1)})`;
      case 3:
        return `(${genScalar(depth - 1)} - ${genScalar(depth - 1)})`;
      case 4:
        return `(${genScalar(depth - 1)} * ${genScalar(depth - 1)})`;
      case 5:
        // Small literal exponent keeps the exact interpreter fast; the
        // budgeted evaluator's own filter below drops anything too big.
        return `(${genScalar(depth - 1)} ^ ${int(5)})`;
      case 6:
        return `-${genScalar(depth - 1)}`;
      default:
        return `(${genCond(depth - 1)} ? ${genScalar(depth - 1)} : ${genScalar(depth - 1)})`;
    }
  }

  function genCond(depth: number): string {
    if (depth <= 0) return String(int(3));
    switch (int(4)) {
      case 0:
        return `(${genScalar(depth - 1)} ${pick(['<', '<=', '>', '>=', '==', '!='])} ${genScalar(depth - 1)})`;
      case 1:
        return `(${genCond(depth - 1)} && ${genCond(depth - 1)})`;
      case 2:
        return `(${genCond(depth - 1)} || ${genCond(depth - 1)})`;
      default:
        return genScalar(depth - 1);
    }
  }

  return () => genScalar(4);
}

test('differential: budgeted evaluator matches the exact interpreter on random small expressions', () => {
  const next = makeGenerator(0x5eed);
  const generous = { maxSteps: 50_000, maxDigits: 2_000 };
  let compared = 0;
  let skipped = 0;
  const mismatches: string[] = [];

  for (let i = 0; i < 2_000; i++) {
    const source = next();
    let outcome;
    try {
      outcome = evaluate(source, generous);
    } catch (error) {
      // Expressions that legitimately exceed the generous budget are not
      // interesting for cross-checking values; skip them (the exact
      // interpreter would need to materialize those huge values).
      assert.ok(error instanceof BudgetError, `unexpected error for ${source}: ${error}`);
      skipped++;
      continue;
    }
    const expected = evaluateExact(source);
    if (outcome.value !== expected) {
      mismatches.push(`${source}: budgeted=${outcome.value} exact=${expected}`);
    }
    compared++;
  }

  assert.deepEqual(mismatches, []);
  assert.ok(compared >= 1_500, `only ${compared} expressions compared (skipped ${skipped})`);
  console.log(`  differential: compared=${compared} skipped(budget)=${skipped}, 0 mismatches`);
});

test('differential: short-circuit semantics agree on generated conditionals', () => {
  const next = makeGenerator(0xc04d);
  for (let i = 0; i < 300; i++) {
    const source = next();
    let value: bigint;
    try {
      value = evaluate(source, { maxSteps: 50_000, maxDigits: 2_000 }).value;
    } catch (error) {
      assert.ok(error instanceof BudgetError);
      continue;
    }
    assert.equal(value, evaluateExact(source), source);
  }
});
