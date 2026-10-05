import test from 'node:test';
import assert from 'node:assert/strict';
import {
  and, col, cmp, eq, lit,
  allTables, scan, filter, project, innerJoin, leftJoin,
  evalPlan, multisetEqual, optimize,
  filterPushdownThroughProject, filterPushdownIntoInnerJoin,
  filterPushdownIntoLeftJoin, leftJoinToInnerJoin, innerJoinCommute,
  projectElimination, projectCollapse, filterMerge,
  BoolExpr, Plan, Table, Value,
} from '../src/index';

// 小表穷举空间：值域 {NULL, 0, 1}，两列，行数 0..2（共 91 张表/侧）。
const DOMAIN: Value[] = [null, 0, 1];
const LEFT_TABLES = allTables('L', ['a', 'b'], DOMAIN, 2);
const RIGHT_TABLES = allTables('R', ['c', 'd'], DOMAIN, 2);
const SINGLE_TABLES = allTables('T', ['a', 'b'], DOMAIN, 3); // 820 张

function checkApplied(out: { cert: { applied: boolean; preconditions: { holds: boolean }[] } }): void {
  assert.ok(out.cert.applied, '规则应当应用');
  assert.ok(out.cert.preconditions.every((p) => p.holds), '证书中所有前置条件必须成立');
}

test('穷举：R1 过滤下推穿过投影（820 张表 × 2 个谓词）', (t) => {
  const preds: BoolExpr[] = [eq(col('a'), lit(0)), cmp('>=', col('a'), lit(1))];
  let cases = 0;
  for (const tbl of SINGLE_TABLES) {
    for (const pred of preds) {
      const before = filter(pred, project(['a'], scan(tbl)));
      const out = filterPushdownThroughProject(before)!;
      checkApplied(out);
      assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)),
        `R1 不等价: ${JSON.stringify(tbl.rows)}`);
      cases++;
    }
  }
  t.diagnostic(`R1 核对 ${cases} 个用例`);
});

test('穷举：R2 过滤下推入内连接（91×91 表对 × 3 个谓词）', (t) => {
  const preds: BoolExpr[] = [
    eq(col('a'), lit(0)),                                  // 仅左侧
    cmp('<>', col('d'), lit(1)),                           // 仅右侧
    and(eq(col('a'), lit(0)), cmp('=', col('d'), lit(1))), // 双侧拆分
  ];
  let cases = 0;
  for (const l of LEFT_TABLES) {
    for (const r of RIGHT_TABLES) {
      for (const pred of preds) {
        const before = filter(pred, innerJoin(eq(col('b'), col('c')), scan(l), scan(r)));
        const out = filterPushdownIntoInnerJoin(before)!;
        checkApplied(out);
        assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
        cases++;
      }
    }
  }
  t.diagnostic(`R2 核对 ${cases} 个用例`);
});

test('穷举：R3 过滤下推入左外连接保留侧（91×91 表对）', (t) => {
  const pred = and(eq(col('a'), lit(0)), cmp('<=', col('b'), lit(1)));
  let cases = 0;
  for (const l of LEFT_TABLES) {
    for (const r of RIGHT_TABLES) {
      const before = filter(pred, leftJoin(eq(col('b'), col('c')), scan(l), scan(r)));
      const out = filterPushdownIntoLeftJoin(before)!;
      checkApplied(out);
      assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
      cases++;
    }
  }
  t.diagnostic(`R3 核对 ${cases} 个用例`);
});

test('穷举：R4 左外连接转内连接（91×91 表对 × 2 个拒绝 NULL 谓词）', (t) => {
  const preds: BoolExpr[] = [
    eq(col('d'), lit(1)),                                  // 比较引用右列
    and(eq(col('a'), lit(0)), cmp('>', col('d'), lit(0))), // 合取中含拒绝 NULL 项
  ];
  let cases = 0;
  for (const l of LEFT_TABLES) {
    for (const r of RIGHT_TABLES) {
      for (const pred of preds) {
        const before = filter(pred, leftJoin(eq(col('b'), col('c')), scan(l), scan(r)));
        const out = leftJoinToInnerJoin(before)!;
        checkApplied(out);
        assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
        cases++;
      }
    }
  }
  t.diagnostic(`R4 核对 ${cases} 个用例`);
});

test('穷举：R5 内连接交换律（91×91 表对）', (t) => {
  let cases = 0;
  for (const l of LEFT_TABLES) {
    for (const r of RIGHT_TABLES) {
      const before = innerJoin(eq(col('b'), col('c')), scan(l), scan(r));
      const out = innerJoinCommute(before)!;
      checkApplied(out);
      assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
      cases++;
    }
  }
  t.diagnostic(`R5 核对 ${cases} 个用例`);
});

test('穷举：R6/R7/R8 投影消除、投影合并、过滤合并（820 张表）', (t) => {
  let cases = 0;
  for (const tbl of SINGLE_TABLES) {
    const r6 = projectElimination(project(['a', 'b'], scan(tbl)))!;
    checkApplied(r6);
    assert.ok(multisetEqual(evalPlan(project(['a', 'b'], scan(tbl))), evalPlan(r6.plan)));

    const r7before = project(['a'], project(['a', 'b'], scan(tbl)));
    const r7 = projectCollapse(r7before)!;
    checkApplied(r7);
    assert.ok(multisetEqual(evalPlan(r7before), evalPlan(r7.plan)));

    const r8before = filter(eq(col('a'), lit(0)), filter(cmp('<=', col('b'), lit(1)), scan(tbl)));
    const r8 = filterMerge(r8before)!;
    checkApplied(r8);
    assert.ok(multisetEqual(evalPlan(r8before), evalPlan(r8.plan)));
    cases += 3;
  }
  t.diagnostic(`R6/R7/R8 核对 ${cases} 个用例`);
});

test('穷举：优化器端到端（过滤+左外连接 => 内连接+双侧下推），91×91 表对', (t) => {
  // SELECT a,b,c,d FROM L LEFT JOIN R ON b=c WHERE a=0 AND d=1
  const buildOriginal = (l: Table, r: Table): Plan =>
    filter(and(eq(col('a'), lit(0)), eq(col('d'), lit(1))),
      leftJoin(eq(col('b'), col('c')), scan(l), scan(r)));
  let cases = 0;
  let sawLojToIj = false;
  for (const l of LEFT_TABLES) {
    for (const r of RIGHT_TABLES) {
      const original = buildOriginal(l, r);
      const { plan, certificates } = optimize(original);
      assert.ok(certificates.length > 0, '应产生重写证书');
      for (const c of certificates) {
        assert.ok(c.applied);
        assert.ok(c.preconditions.every((p) => p.holds), '只执行前置条件证明合法的规则');
        if (c.rule === 'left-join-to-inner-join') sawLojToIj = true;
      }
      assert.ok(multisetEqual(evalPlan(original), evalPlan(plan)),
        `优化后不等价: L=${JSON.stringify(l.rows)} R=${JSON.stringify(r.rows)}`);
      cases++;
    }
  }
  assert.ok(sawLojToIj, '优化链中应出现外连接转内连接');
  t.diagnostic(`端到端核对 ${cases} 个用例`);
});
