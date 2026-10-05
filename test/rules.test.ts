import test from 'node:test';
import assert from 'node:assert/strict';
import {
  and, col, cmp, eq, lit, notNull,
  table, scan, filter, project, innerJoin, leftJoin,
  evalPlan, multisetEqual, renderPlan,
  filterPushdownThroughProject, filterPushdownIntoInnerJoin,
  filterPushdownIntoLeftJoin, leftJoinToInnerJoin, innerJoinCommute,
  projectElimination, projectCollapse, filterMerge,
  Plan,
} from '../src/index';

const T = table('T', ['a', 'b'], [[1, 10], [null, 20], [1, 10], [null, null]]);
const S = table('S', ['c', 'd'], [[10, 'x'], [30, 'y'], [null, 'z']]);

function assertCertShape(out: { cert: { rule: string; applied: boolean; preconditions: unknown[]; before: string; after: string; justification: string } }): void {
  assert.ok(out.cert.rule.length > 0);
  assert.ok(out.cert.before.length > 0);
  assert.ok(out.cert.after.length > 0);
  assert.ok(out.cert.justification.length > 0);
}

test('R1 过滤下推穿过投影：前置满足时应用并等价', () => {
  const before = filter(eq(col('a'), lit(1)), project(['a'], scan(T)));
  const out = filterPushdownThroughProject(before)!;
  assertCertShape(out);
  assert.equal(out.cert.applied, true);
  assert.ok(out.cert.preconditions.every((p) => (p as { holds: boolean }).holds));
  assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
});

test('R1 前置不满足（谓词引用被投影丢弃的列）=> 拒绝执行', () => {
  const before = filter(eq(col('b'), lit(10)), project(['a'], scan(T)));
  const out = filterPushdownThroughProject(before)!;
  assert.equal(out.cert.applied, false);
  assert.equal(out.plan, before, '计划必须保持不变');
  assert.equal(out.cert.after, '(unchanged)');
});

test('R2 过滤下推入内连接：合取项按侧拆分', () => {
  const pred = and(eq(col('a'), lit(1)), cmp('>', col('d'), lit('w')), eq(col('b'), col('c')));
  const before = filter(pred, innerJoin(eq(col('b'), col('c')), scan(T), scan(S)));
  const out = filterPushdownIntoInnerJoin(before)!;
  assert.equal(out.cert.applied, true);
  assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
  // 双侧过滤都被下推，连接上方只剩跨列谓词 b = c
  assert.equal(out.plan.kind, 'filter');
  if (out.plan.kind === 'filter') {
    assert.deepEqual(out.plan.pred, eq(col('b'), col('c')));
    assert.equal(out.plan.child.kind, 'innerJoin');
    if (out.plan.child.kind === 'innerJoin') {
      assert.equal(out.plan.child.left.kind, 'filter');
      assert.equal(out.plan.child.right.kind, 'filter');
    }
  }
});

test('R2 无可下推合取项 => 拒绝执行', () => {
  const before = filter(eq(col('b'), col('c')), innerJoin(eq(col('b'), col('c')), scan(T), scan(S)));
  const out = filterPushdownIntoInnerJoin(before)!;
  assert.equal(out.cert.applied, false);
  assert.equal(out.plan, before);
});

test('R3 过滤下推入左外连接保留侧', () => {
  const before = filter(eq(col('a'), lit(1)), leftJoin(eq(col('b'), col('c')), scan(T), scan(S)));
  const out = filterPushdownIntoLeftJoin(before)!;
  assert.equal(out.cert.applied, true);
  assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
});

test('R4 左外连接转内连接：谓词拒绝 NULL 时合法', () => {
  const pred = and(eq(col('a'), lit(1)), cmp('=', col('d'), lit('x')));
  const before = filter(pred, leftJoin(eq(col('b'), col('c')), scan(T), scan(S)));
  const out = leftJoinToInnerJoin(before)!;
  assert.equal(out.cert.applied, true);
  assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
});

test('R4 谓词接受 NULL（IS NULL / 不引用右列）=> 拒绝执行', () => {
  const p1 = filter(notNull(col('a')), leftJoin(eq(col('b'), col('c')), scan(T), scan(S)));
  assert.equal(leftJoinToInnerJoin(p1)!.cert.applied, false);
  const p2 = filter(eq(col('a'), lit(1)), leftJoin(eq(col('b'), col('c')), scan(T), scan(S)));
  assert.equal(leftJoinToInnerJoin(p2)!.cert.applied, false);
});

test('R4 反例：若无此前置条件，重写确实不等价', () => {
  // T2 中 (1,99) 无匹配：外连接补 NULL 后 a=1 为 TRUE 被保留；内连接直接丢弃 => 结果不同
  const T2 = table('T2', ['a', 'b'], [[1, 99], [1, 10]]);
  const pred = eq(col('a'), lit(1)); // 不拒绝右侧 NULL
  const loj = filter(pred, leftJoin(eq(col('b'), col('c')), scan(T2), scan(S)));
  const ij = filter(pred, innerJoin(eq(col('b'), col('c')), scan(T2), scan(S)));
  assert.ok(!multisetEqual(evalPlan(loj), evalPlan(ij)));
});

test('R3 反例：向 nullable 侧下推过滤不等价（故无此规则）', () => {
  const pred = cmp('=', col('d'), lit('x'));
  const loj = filter(pred, leftJoin(eq(col('b'), col('c')), scan(T), scan(S)));
  const pushed = leftJoin(eq(col('b'), col('c')), scan(T), filter(pred, scan(S)));
  assert.ok(!multisetEqual(evalPlan(loj), evalPlan(pushed)));
});

test('R5 内连接交换律（投影恢复列序）', () => {
  const before = innerJoin(eq(col('b'), col('c')), scan(T), scan(S));
  const out = innerJoinCommute(before)!;
  assert.equal(out.cert.applied, true);
  assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
});

test('R6 恒等投影消除；列序不同则拒绝', () => {
  const id = project(['a', 'b'], scan(T));
  assert.equal(projectElimination(id)!.cert.applied, true);
  assert.equal(projectElimination(id)!.plan.kind, 'scan');
  const reordered: Plan = project(['b', 'a'], scan(T));
  assert.equal(projectElimination(reordered)!.cert.applied, false);
});

test('R7 级联投影合并', () => {
  const before = project(['a'], project(['a', 'b'], scan(T)));
  const out = projectCollapse(before)!;
  assert.equal(out.cert.applied, true);
  assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
  const bad = project(['b'], project(['a'], scan(T)));
  assert.equal(projectCollapse(bad)!.cert.applied, false);
});

test('R8 级联过滤合并', () => {
  const before = filter(eq(col('a'), lit(1)), filter(cmp('>', col('b'), lit(5)), scan(T)));
  const out = filterMerge(before)!;
  assert.equal(out.cert.applied, true);
  assert.ok(multisetEqual(evalPlan(before), evalPlan(out.plan)));
});
