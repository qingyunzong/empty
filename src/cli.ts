/** 命令行：求解演示实例，输出旧布局违例摘要 + 可校验约束证书（JSON）。 */

import { demoSpec, oldLayout } from './instance.js';
import { solve } from './solver.js';
import { checkLayout } from './constraints.js';
import { buildCertificate, verifyCertificate } from './verify.js';

const spec = demoSpec();

console.log('=== 旧布局约束检查 ===');
for (const c of checkLayout(spec, oldLayout(spec))) {
  if (!c.satisfied) console.log(`违反: ${c.detail}`);
}

const budget = process.argv[2] ? Number(process.argv[2]) : undefined;
const result = solve(spec, budget !== undefined ? { nodeBudget: budget } : {});
const cert = buildCertificate(spec, result);
const verification = verifyCertificate(cert);

console.log('\n=== 求解结果 ===');
console.log(`状态: ${result.status}  目标值(上界): ${result.upperBound}  下界: ${result.lowerBound}  展开节点: ${result.nodesExplored}`);

console.log('\n=== 约束证书 (JSON) ===');
console.log(JSON.stringify(cert, null, 2));

console.log('\n=== 独立校验 ===');
console.log(verification.ok ? 'OK: 证书有效' : `失败: ${verification.problems.join('; ')}`);
if (!verification.ok) process.exitCode = 1;
