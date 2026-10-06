import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  Problem,
  solve,
  solutionMatchesEnumeration,
  verifyByEnumeration,
} from '../src/index.js';
import { makeRng, randomProblem } from './helpers.js';

describe('树 DP (无耦合)', () => {
  test('非凹收益表: 与叶向量枚举一致', () => {
    const problem: Problem = {
      totalBudget: 10,
      root: {
        kind: 'internal', id: 'R', min: 0, max: 80,
        children: [
          { kind: 'leaf', id: 'a', min: 0, max: 5, payoff: [0, 1, 1, 9, 9, 9] },
          { kind: 'leaf', id: 'b', min: 0, max: 5, payoff: [0, 4, 4, 4, 4, 12] },
        ],
      },
    };
    const { solution } = solve(problem);
    assert.equal(solution.status, 'optimal');
    assert.equal(solution.closed, true);
    assert.ok(solutionMatchesEnumeration(problem, solution));
    assert.equal(solution.payoff, 21);
    assert.deepEqual(solution.allocation, { a: 3, b: 5 });
    assert.equal(solution.nodeSums.R, 8);
  });

  test('平局序: 先比总拨款小, 再比叶向量字典序小', () => {
    const problem: Problem = {
      totalBudget: 3,
      root: {
        kind: 'internal', id: 'R', min: 0, max: 80,
        children: [
          { kind: 'leaf', id: 'a', min: 0, max: 2, payoff: [0, 6, 8] },
          { kind: 'leaf', id: 'b', min: 0, max: 2, payoff: [0, 4, 6] },
        ],
      },
    };
    const { solution } = solve(problem);
    // (1,2) 与 (2,1) 收益同为 12、总额同为 3, 取字典序小的 (1,2)
    assert.equal(solution.payoff, 12);
    assert.deepEqual(solution.allocation, { a: 1, b: 2 });
    const problem2: Problem = {
      totalBudget: 10,
      root: {
        kind: 'internal', id: 'R', min: 0, max: 80,
        children: [
          { kind: 'leaf', id: 'a', min: 0, max: 2, payoff: [0, 7, 7] },
          { kind: 'leaf', id: 'b', min: 0, max: 2, payoff: [0, 3, 3] },
        ],
      },
    };
    const res2 = solve(problem2);
    // 收益 10 可由 (1,1) 总额 2 或 (2,2) 总额 4 达到, 取总额小者
    assert.equal(res2.solution.payoff, 10);
    assert.deepEqual(res2.solution.allocation, { a: 1, b: 1 });
    assert.equal(res2.solution.totalAllocated, 2);
  });

  test('节点汇总上下界: 违反即不可行', () => {
    const problem: Problem = {
      totalBudget: 80,
      root: {
        kind: 'internal', id: 'R', min: 5, max: 6,
        children: [
          { kind: 'leaf', id: 'a', min: 0, max: 2, payoff: [0, 1, 2] },
          { kind: 'leaf', id: 'b', min: 0, max: 2, payoff: [0, 1, 2] },
        ],
      },
    };
    const { solution } = solve(problem);
    assert.equal(solution.status, 'infeasible');
    assert.equal(solution.closed, true);
    assert.equal(verifyByEnumeration(problem), null);
  });

  test('节点汇总界约束解的形状', () => {
    const problem: Problem = {
      totalBudget: 80,
      root: {
        kind: 'internal', id: 'R', min: 0, max: 80,
        children: [
          {
            kind: 'internal', id: 'G', min: 3, max: 4,
            children: [
              { kind: 'leaf', id: 'a', min: 0, max: 6, payoff: [0, 1, 2, 3, 4, 5, 6] },
              { kind: 'leaf', id: 'b', min: 0, max: 6, payoff: [0, 1, 2, 3, 4, 5, 6] },
            ],
          },
          { kind: 'leaf', id: 'c', min: 0, max: 6, payoff: [0, 9, 9, 9, 9, 9, 9] },
        ],
      },
    };
    const { solution } = solve(problem);
    assert.equal(solution.status, 'optimal');
    assert.ok(solution.nodeSums.G >= 3 && solution.nodeSums.G <= 4);
    assert.ok(solutionMatchesEnumeration(problem, solution));
  });

  test('总预算上限 80 的校验', () => {
    const problem: Problem = {
      totalBudget: 81,
      root: { kind: 'leaf', id: 'a', min: 0, max: 1, payoff: [0, 1] },
    };
    assert.throws(() => solve(problem), /80/);
  });

  test('随机实例: DP 与枚举核验一致 (30 例)', () => {
    const rng = makeRng(20261006);
    for (let t = 0; t < 30; t++) {
      const problem = randomProblem(rng, {
        leafCount: 3 + Math.floor(rng() * 3),
        maxAlloc: 5,
        budget: 10 + Math.floor(rng() * 70),
      });
      const { solution } = solve(problem);
      assert.equal(solution.closed, true);
      assert.ok(
        solutionMatchesEnumeration(problem, solution),
        `第 ${t} 例不一致: ${JSON.stringify(problem)}`,
      );
    }
  });
});
