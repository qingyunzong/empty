import { readFileSync } from 'node:fs';
import { solve, solutionMatchesEnumeration } from './solve.js';
import { Problem } from './types.js';

/**
 * 用法: node dist/src/cli.js <problem.json> [--budget N] [--verify]
 *   --budget N  工作预算(搜索节点访问量上限), 仅对耦合问题生效
 *   --verify    额外跑叶向量枚举核验并输出是否一致
 */
function main(): void {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) {
    console.error('用法: node dist/src/cli.js <problem.json> [--budget N] [--verify]');
    process.exitCode = 2;
    return;
  }
  const problem = JSON.parse(readFileSync(file, 'utf8')) as Problem;
  const budgetIdx = args.indexOf('--budget');
  const workBudget = budgetIdx >= 0 ? Number(args[budgetIdx + 1]) : undefined;
  const doVerify = args.includes('--verify');

  const { solution } = solve(problem, { workBudget });
  const out: Record<string, unknown> = { solution };
  if (doVerify) {
    out.matchesEnumeration = solutionMatchesEnumeration(problem, solution);
  }
  console.log(JSON.stringify(out, null, 2));
  if (solution.status === 'infeasible' || solution.status === 'unknown') {
    process.exitCode = 1;
  }
}

main();
