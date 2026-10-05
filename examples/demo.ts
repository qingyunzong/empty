// 演示：优化一条含左外连接的查询并打印重写证书。
import { and, col, eq, lit, leftJoin, scan, table, optimize, renderPlan, evalPlan, multisetEqual } from '../src/index';

const L = table('L', ['a', 'b'], [[0, 1], [1, 2], [null, 3], [0, 1]]);
const R = table('R', ['c', 'd'], [[1, 1], [2, 0], [null, null]]);

// SELECT * FROM L LEFT JOIN R ON b = c WHERE a = 0 AND d = 1
const original = leftJoin(eq(col('b'), col('c')), scan(L), scan(R));
const query = { kind: 'filter' as const, pred: and(eq(col('a'), lit(0)), eq(col('d'), lit(1))), child: original };

const { plan, certificates } = optimize(query);
console.log('原查询:  ', renderPlan(query));
console.log('优化后:  ', renderPlan(plan));
console.log('结果等价:', multisetEqual(evalPlan(query), evalPlan(plan)));
console.log('\n重写证书:');
for (const c of certificates) {
  console.log(`\n[${c.rule}] applied=${c.applied}`);
  for (const p of c.preconditions) console.log(`  前置条件 ${p.name}: ${p.holds ? '成立' : '不成立'} — ${p.detail}`);
  console.log(`  before: ${c.before}`);
  console.log(`  after:  ${c.after}`);
  console.log(`  依据:   ${c.justification}`);
}
