import { Allocator } from './allocator.ts';
import { compareWithUnitModel } from './compare.ts';
import type { AllocationResult } from './allocator.ts';

function printResult(title: string, res: AllocationResult): void {
  console.log(`\n=== ${title} ===`);
  console.log(`总容量: ${res.capacity}  已分配: ${res.allocatedTotal}  未服务容量: ${res.unservedCapacity}`);
  console.log('逐轮饱和证据:');
  for (const r of res.rounds) {
    const sat = r.saturatedIds.length > 0 ? r.saturatedIds.join(', ') : '(无)';
    console.log(
      `  轮次 ${r.round}: 水位=${r.level} (~${r.levelValue.toFixed(4)})  饱和=[${sat}]  剩余容量=${r.capacityRemaining}`,
    );
    console.log(`    累计分数应得: ${JSON.stringify(r.cumulativeFractional)}`);
  }
  console.log('最终整数分配 vs 分数应得:');
  for (const id of Object.keys(res.allocation).sort()) {
    const frac = res.fractional[id];
    const sat = res.saturationRound[id] ? `饱和于第 ${res.saturationRound[id]} 轮` : '未饱和';
    console.log(`  ${id}: ${res.allocation[id]}  (分数应得 ${frac}, ${sat})`);
  }
  if (res.remainderRecipients.length > 0) {
    console.log(`余数按 ID 补分接收者: ${res.remainderRecipients.join(', ')}`);
  }
}

const capacity = 100;
const allocator = new Allocator(capacity);
allocator.addUser({ id: 'alpha', demand: 5, weight: 1, cap: 10 });
allocator.addUser({ id: 'beta', demand: 50, weight: 1, cap: 60 });
allocator.addUser({ id: 'gamma', demand: 1000, weight: 1, cap: 1000 });
allocator.addUser({ id: 'delta', demand: 40, weight: 3, cap: 45 });

const first = allocator.allocate();
printResult('初始分摊', first);

const report = compareWithUnitModel(capacity, allocator.listUsers(), first);
console.log('\n=== 与逐单位小容量模型对照 ===');
for (const row of report.rows) {
  console.log(
    `  ${row.id}: 逐轮=${row.roundModel}  逐单位=${row.unitModel}  差=${row.diff}  分数应得=${row.fractional}`,
  );
}
console.log(
  `  合计: 逐轮=${report.roundModelTotal}  逐单位=${report.unitModelTotal}  最大绝对差=${report.maxAbsDiff}`,
);

console.log("\n>>> 撤销 'delta' 的需求,重新分摊 ...");
allocator.revoke('delta');
const second = allocator.allocate();
printResult('撤销后重新分摊', second);
