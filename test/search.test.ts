import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  Problem,
  SearchState,
  solve,
  solutionMatchesEnumeration,
} from '../src/index.js';
import { makeRng, randomProblem } from './helpers.js';

function coupledFixture(): Problem {
  // 两子树各两叶; 收益把 a 推向大额、把 d 推向大额,
  // 跨子树约束 |a - d| <= 1 使两子树无法独立优化.
  return {
    totalBudget: 8,
    root: {
      kind: 'internal', id: 'R', min: 0, max: 80,
      children: [
        {
          kind: 'internal', id: 'G1', min: 0, max: 80,
          children: [
            { kind: 'leaf', id: 'a', min: 0, max: 4, payoff: [0, 1, 2, 3, 20] },
            { kind: 'leaf', id: 'b', min: 0, max: 4, payoff: [0, 1, 1, 1, 1] },
          ],
        },
        {
          kind: 'internal', id: 'G2', min: 0, max: 80,
          children: [
            { kind: 'leaf', id: 'c', min: 0, max: 4, payoff: [0, 1, 1, 1, 1] },
            { kind: 'leaf', id: 'd', min: 0, max: 4, payoff: [0, 5, 5, 5, 5] },
          ],
        },
      ],
    },
    cross: [{ leafA: 'a', leafB: 'd', maxDiff: 1 }],
  };
}

describe('耦合问题: 跨子树差值约束 + 启动费', () => {
  test('跨子树约束生效且跨边证书成立', () => {
    const problem = coupledFixture();
    const { solution } = solve(problem);
    assert.equal(solution.status, 'optimal');
    assert.equal(solution.closed, true);
    // 无约束时最优为 a=4,d=1 (|4-1|=3 违反), 有约束须联动
    assert.ok(Math.abs(solution.allocation.a - solution.allocation.d) <= 1);
    assert.equal(solution.crossCertificates.length, 1);
    const cert = solution.crossCertificates[0];
    assert.equal(cert.satisfied, true);
    assert.equal(cert.diff, Math.abs(cert.xA - cert.xB));
    assert.ok(cert.diff <= cert.maxDiff);
    assert.ok(solutionMatchesEnumeration(problem, solution));
  });

  test('启动费计入总预算且不影响节点汇总', () => {
    const problem: Problem = {
      totalBudget: 5,
      root: {
        kind: 'internal', id: 'R', min: 0, max: 80,
        children: [
          { kind: 'leaf', id: 'a', min: 0, max: 3, payoff: [0, 10, 11, 12], startupFee: 3 },
          { kind: 'leaf', id: 'b', min: 0, max: 3, payoff: [0, 4, 5, 6] },
        ],
      },
    };
    const { solution } = solve(problem);
    assert.equal(solution.status, 'optimal');
    // a=1 (费3) + b=1: 花费 1+3+1=5, 收益 14 为最优
    assert.deepEqual(solution.allocation, { a: 1, b: 1 });
    assert.equal(solution.payoff, 14);
    assert.equal(solution.totalAllocated, 2);
    assert.equal(solution.totalFees, 3);
    assert.ok(solution.totalAllocated + solution.totalFees <= 5);
    assert.equal(solution.nodeSums.R, 2); // 汇总不含启动费
    assert.ok(solutionMatchesEnumeration(problem, solution));
  });

  test('工作预算: 未闭合不得标最优, 续算后闭合并达最优', () => {
    const problem = coupledFixture();
    const first = solve(problem, { workBudget: 1 });
    assert.equal(first.solution.closed, false);
    assert.notEqual(first.solution.status, 'optimal');
    assert.ok(first.state);
    // 续算直至闭合
    let state: SearchState = first.state!;
    let result = first;
    for (let round = 0; round < 1000 && !result.solution.closed; round++) {
      result = solve(problem, { state, workBudget: 50 });
      state = result.state!;
    }
    assert.equal(result.solution.closed, true);
    assert.equal(result.solution.status, 'optimal');
    assert.ok(solutionMatchesEnumeration(problem, result.solution));
  });

  test('状态可 JSON 序列化并续算, 结果一致', () => {
    const problem = coupledFixture();
    const paused = solve(problem, { workBudget: 3 });
    assert.equal(paused.solution.closed, false);
    const revived: SearchState = JSON.parse(JSON.stringify(paused.state));
    const finished = solve(problem, { state: revived });
    assert.equal(finished.solution.closed, true);
    const direct = solve(problem);
    assert.deepEqual(finished.solution.allocation, direct.solution.allocation);
    assert.equal(finished.solution.payoff, direct.solution.payoff);
  });

  test('跨子树约束超过 10 条被拒绝', () => {
    const problem = coupledFixture();
    problem.cross = Array.from({ length: 11 }, () => ({ leafA: 'a', leafB: 'd', maxDiff: 1 }));
    assert.throws(() => solve(problem), /10/);
  });

  test('随机耦合实例: 搜索与枚举核验一致 (30 例)', () => {
    const rng = makeRng(1234567);
    for (let t = 0; t < 30; t++) {
      const problem = randomProblem(rng, {
        leafCount: 3 + Math.floor(rng() * 2),
        maxAlloc: 3,
        budget: 6 + Math.floor(rng() * 10),
        withFees: true,
        crossCount: 1 + Math.floor(rng() * 3),
      });
      const { solution } = solve(problem);
      assert.equal(solution.closed, true);
      assert.ok(
        solutionMatchesEnumeration(problem, solution),
        `第 ${t} 例不一致: ${JSON.stringify(problem)}`,
      );
      for (const cert of solution.crossCertificates) {
        assert.ok(cert.satisfied, `证书不成立: ${JSON.stringify(cert)}`);
      }
    }
  });
});
