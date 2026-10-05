import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completenessBound,
  enumerateParses,
  parse,
  preorderRuleIds,
  treeCost,
  treeDepth,
  verifyCertificate,
} from '../src/index';
import { mulberry32, randomCase } from './rand';

test('recursive grammar: DP matches exhaustive enumeration', () => {
  const checkAll = (
    grammar: Parameters<typeof parse>[0],
    sequences: string[][],
  ): void => {
    for (const sequence of sequences) {
      const bound = completenessBound(grammar, sequence.length);
      const oracle = enumerateParses(grammar, sequence, bound);
      assert.equal(oracle.truncated, false, `enumeration exploded for ${JSON.stringify(sequence)}`);
      const dp = parse(grammar, sequence);
      assert.notEqual(dp.status, 'infeasible');
      if (dp.status === 'infeasible') return;
      assert.equal(dp.cost, oracle.minCost);
      assert.ok(treeDepth(dp.tree) <= bound);
    }
  };

  // Binary recursion without epsilon (Catalan-many trees: small).
  checkAll(
    {
      start: 'S',
      rules: [
        { id: 1, lhs: 'S', rhs: ['S', 'S'], cost: 1 },
        { id: 2, lhs: 'S', rhs: ['a'], cost: 2 },
      ],
    },
    [['a'], ['a', 'a'], ['a', 'a', 'a'], ['a', 'a', 'a', 'a']],
  );

  // Binary recursion WITH epsilon: tree counts explode with length,
  // so only very short sequences are exhaustively enumerable.
  checkAll(
    {
      start: 'S',
      rules: [
        { id: 1, lhs: 'S', rhs: ['S', 'S'], cost: 1 },
        { id: 2, lhs: 'S', rhs: ['a'], cost: 2 },
        { id: 3, lhs: 'S', rhs: [], cost: 3 },
      ],
    },
    [[], ['a']],
  );
});

test('random small grammars: DP optimum equals bounded-exhaustive optimum', () => {
  const rand = mulberry32(0xC0FFEE);
  let compared = 0;
  let infeasibleCount = 0;
  let attempts = 0;
  const TARGET = 300;
  const MAX_ATTEMPTS = 20_000;

  while (compared < TARGET && attempts < MAX_ATTEMPTS) {
    attempts++;
    const { grammar, sequence } = randomCase(rand);
    const bound = completenessBound(grammar, sequence.length);
    const oracle = enumerateParses(grammar, sequence, bound, 200_000);
    if (oracle.truncated) continue; // too many trees to enumerate; skip this case

    const dp = parse(grammar, sequence);
    if (dp.status === 'infeasible') {
      assert.equal(
        oracle.count,
        0,
        `DP says infeasible but oracle found ${oracle.count} trees: ${JSON.stringify(grammar)} seq=${JSON.stringify(sequence)}`,
      );
      infeasibleCount++;
    } else {
      assert.equal(
        dp.cost,
        oracle.minCost,
        `cost mismatch: ${JSON.stringify(grammar)} seq=${JSON.stringify(sequence)}`,
      );
      // The certificate must verify and its cost must be real.
      assert.deepEqual(verifyCertificate(grammar, dp.certificate), { ok: true });
      const costOf = (id: number): number => grammar.rules.find((r) => r.id === id)!.cost;
      assert.equal(treeCost(dp.tree, costOf), dp.cost);
      assert.deepEqual(preorderRuleIds(dp.tree), dp.ruleIds);
    }
    compared++;
  }

  assert.ok(compared >= TARGET, `only ${compared} comparable cases in ${attempts} attempts`);
  assert.ok(infeasibleCount > 0, 'expected some infeasible random cases to be exercised');
  console.log(`  cross-checked ${compared} random grammars (${infeasibleCount} infeasible), ${attempts} attempts`);
});
