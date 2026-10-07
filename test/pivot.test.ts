import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PivotTable,
  renderPivot,
  type Key,
  type PivotNode,
} from '../src/pivot.js';

function findNode(root: PivotNode, path: Key[]): PivotNode {
  let node = root;
  for (const key of path) {
    const next = node.children.find((c) => c.key === key);
    assert.ok(next, `节点缺失: ${JSON.stringify(path)}`);
    node = next;
  }
  return node;
}

test('多层行列键汇总：树状行列、小计与总计', () => {
  const t = new PivotTable();
  t.apply({ eventId: 'e1', rowPath: ['华东', '上海'], colPath: ['2025', 'Q1'], delta: 100 });
  t.apply({ eventId: 'e2', rowPath: ['华东', '上海'], colPath: ['2025', 'Q2'], delta: 50 });
  t.apply({ eventId: 'e3', rowPath: ['华东', '杭州'], colPath: ['2025', 'Q1'], delta: 30 });
  t.apply({ eventId: 'e4', rowPath: ['华北', '北京'], colPath: ['2026', 'Q1'], delta: 20 });

  const out = t.build();
  assert.equal(out.grandTotal, 200n);

  assert.equal(findNode(out.rows, ['华东']).subtotal, 180n);
  assert.equal(findNode(out.rows, ['华东', '上海']).subtotal, 150n);
  assert.equal(findNode(out.rows, ['华东', '杭州']).subtotal, 30n);
  assert.equal(findNode(out.rows, ['华北']).subtotal, 20n);
  assert.equal(findNode(out.rows, ['华北', '北京']).subtotal, 20n);

  assert.equal(findNode(out.columns, ['2025']).subtotal, 180n);
  assert.equal(findNode(out.columns, ['2025', 'Q1']).subtotal, 130n);
  assert.equal(findNode(out.columns, ['2025', 'Q2']).subtotal, 50n);
  assert.equal(findNode(out.columns, ['2026', 'Q1']).subtotal, 20n);

  assert.equal(out.cells.length, 4);
  const cell = out.cells.find(
    (c) => c.rowPath.join('/') === '华东/上海' && c.colPath.join('/') === '2025/Q1',
  );
  assert.equal(cell?.value, 100n);

  const report = t.reconcile();
  assert.ok(report.ok, JSON.stringify(report.mismatches));
  assert.equal(report.grandTotal.tree, 200n);
});

test('精确整数：超出 Number.MAX_SAFE_INTEGER 仍精确', () => {
  const t = new PivotTable();
  const big = 9007199254740993n; // 2^53 + 1，number 无法精确表示
  t.apply({ eventId: 'b1', rowPath: ['A'], colPath: ['X'], delta: big });
  t.apply({ eventId: 'b2', rowPath: ['A'], colPath: ['X'], delta: big });
  t.apply({ eventId: 'b3', rowPath: ['A'], colPath: ['Y'], delta: '123456789012345678901234567890' });

  const out = t.build();
  assert.equal(findNode(out.rows, ['A']).subtotal, 18014398509481986n + 123456789012345678901234567890n);
  const cellX = out.cells.find((c) => c.colPath[0] === 'X');
  assert.equal(cellX?.value, 18014398509481986n);
  assert.ok(t.reconcile().ok);
});

test('NULL 独立分类：null 与字符串 "null" 及其他键互不混淆', () => {
  const t = new PivotTable();
  t.apply({ eventId: 'n1', rowPath: [null], colPath: ['C'], delta: 5 });
  t.apply({ eventId: 'n2', rowPath: ['null'], colPath: ['C'], delta: 7 });
  t.apply({ eventId: 'n3', rowPath: ['A', null], colPath: [null], delta: 11 });
  t.apply({ eventId: 'n4', rowPath: ['A', 'B'], colPath: [null], delta: 13 });

  const out = t.build();
  assert.equal(out.grandTotal, 36n);

  // 行根下：NULL 类别、"null" 字符串、"A" 三者并列且独立
  assert.equal(findNode(out.rows, [null]).subtotal, 5n);
  assert.equal(findNode(out.rows, ['null']).subtotal, 7n);
  assert.equal(findNode(out.rows, ['A']).subtotal, 24n);
  assert.equal(findNode(out.rows, ['A', null]).subtotal, 11n);
  assert.equal(findNode(out.rows, ['A', 'B']).subtotal, 13n);
  assert.equal(out.rows.children.length, 3);

  // 列根下：'C' 与 NULL 类别独立
  assert.equal(findNode(out.columns, ['C']).subtotal, 12n);
  assert.equal(findNode(out.columns, [null]).subtotal, 24n);
  assert.equal(out.columns.children.length, 2);

  assert.ok(t.reconcile().ok);
});

test('小计不重复计算叶数据：subtotal = direct + 子节点之和，每叶只计一次', () => {
  const t = new PivotTable();
  // 故意混入不同深度的路径，制造“节点自身带叶数据”的情形
  t.apply({ eventId: 's1', rowPath: ['A'], colPath: ['X'], delta: 10 });
  t.apply({ eventId: 's2', rowPath: ['A', 'a1'], colPath: ['X'], delta: 20 });
  t.apply({ eventId: 's3', rowPath: ['A', 'a1', 'deep'], colPath: ['Y'], delta: 4 });
  t.apply({ eventId: 's4', rowPath: ['A', 'a2'], colPath: ['X', 'x1'], delta: 30 });
  t.apply({ eventId: 's5', rowPath: ['B'], colPath: [null], delta: 6 });

  const out = t.build();

  const checkNode = (node: PivotNode): void => {
    const childSum = node.children.reduce((acc, c) => acc + c.subtotal, 0n);
    assert.equal(
      node.subtotal,
      node.direct + childSum,
      `节点 ${JSON.stringify(node.path)} 小计重复或漏算`,
    );
    node.children.forEach(checkNode);
  };
  checkNode(out.rows);
  checkNode(out.columns);

  // 每片叶恰好计入一次：所有节点 direct 之和 = 叶单元格之和 = 总计
  const sumDirect = (node: PivotNode): bigint =>
    node.direct + node.children.reduce((acc, c) => acc + sumDirect(c), 0n);
  const cellSum = out.cells.reduce((acc, c) => acc + c.value, 0n);
  assert.equal(sumDirect(out.rows), cellSum);
  assert.equal(out.grandTotal, cellSum);
  assert.equal(out.grandTotal, 70n);

  assert.ok(t.reconcile().ok);
});

test('更正带事件 ID：同一 eventId 幂等，重复提交不影响结果', () => {
  const t = new PivotTable();
  const evt = { eventId: 'c1', rowPath: ['A'], colPath: ['X'], delta: 100 };
  assert.equal(t.apply(evt), 'applied');
  assert.equal(t.apply(evt), 'duplicate');
  assert.equal(t.apply({ ...evt, delta: 999 }), 'duplicate'); // 同 ID 不同金额也去重
  t.apply({ eventId: 'c2', rowPath: ['A'], colPath: ['X'], delta: -40, correctionOf: 'c1' });

  const out = t.build();
  assert.equal(out.grandTotal, 60n);
  assert.ok(t.reconcile().ok);
});

test('空组核对：净额为 0 的组不进树，且在核对报告中列出', () => {
  const t = new PivotTable();
  t.apply({ eventId: 'z1', rowPath: ['A'], colPath: ['X'], delta: 100 });
  t.apply({ eventId: 'z2', rowPath: ['A'], colPath: ['X'], delta: -100, correctionOf: 'z1' });
  t.apply({ eventId: 'z3', rowPath: ['B'], colPath: ['X'], delta: 5 });

  const out = t.build();
  assert.equal(out.cells.length, 1);
  assert.equal(out.grandTotal, 5n);
  assert.equal(out.rows.children.length, 1);
  assert.equal(out.rows.children[0]?.key, 'B');

  const report = t.reconcile();
  assert.ok(report.ok, JSON.stringify(report.mismatches));
  assert.equal(report.emptyGroups.length, 1);
  assert.deepEqual(report.emptyGroups[0], { rowPath: ['A'], colPath: ['X'] });
});

test('跨组迁移：更正链把金额从 A×X 迁到 B×Y，总计守恒且被报告', () => {
  const t = new PivotTable();
  t.apply({ eventId: 'm1', rowPath: ['A'], colPath: ['X'], delta: 500 });
  t.apply({ eventId: 'm2', rowPath: ['A'], colPath: ['X'], delta: -500, correctionOf: 'm1' });
  t.apply({ eventId: 'm3', rowPath: ['B'], colPath: ['Y'], delta: 500, correctionOf: 'm1' });

  const out = t.build();
  assert.equal(out.grandTotal, 500n); // 迁移守恒
  assert.equal(findNode(out.rows, ['B']).subtotal, 500n);
  assert.equal(out.rows.children.length, 1); // A 已迁空，不出现

  const report = t.reconcile();
  assert.ok(report.ok, JSON.stringify(report.mismatches));
  assert.equal(report.migrations.length, 1);
  const migration = report.migrations[0];
  assert.ok(migration);
  assert.equal(migration.chainId, 'm1');
  assert.equal(migration.groups.length, 2);
  assert.equal(migration.total, 500n);
  const from = migration.groups.find((g) => g.rowPath[0] === 'A');
  const to = migration.groups.find((g) => g.rowPath[0] === 'B');
  assert.equal(from?.net, 0n); // 源组 +500/-500 抵消
  assert.equal(to?.net, 500n);
  assert.equal(report.emptyGroups.length, 1); // 源组成为空组
});

test('非法输入被拒绝', () => {
  const t = new PivotTable();
  assert.throws(() =>
    t.apply({ eventId: 'x1', rowPath: ['A'], colPath: ['X'], delta: 1.5 }),
  );
  assert.throws(() =>
    t.apply({ eventId: 'x2', rowPath: ['A'], colPath: ['X'], delta: 'abc' }),
  );
  assert.throws(() =>
    t.apply({ eventId: '', rowPath: ['A'], colPath: ['X'], delta: 1 }),
  );
  assert.throws(() =>
    t.apply({ eventId: 'x3', rowPath: [1 as unknown as string], colPath: ['X'], delta: 1 }),
  );
});

test('综合场景：reconcile 与全表分组一致（含 NULL、空组、迁移、大数）', () => {
  const t = new PivotTable();
  t.apply({ eventId: 'g1', rowPath: ['华东', null], colPath: ['2025'], delta: 9007199254740993n });
  t.apply({ eventId: 'g2', rowPath: [null], colPath: [null, 'Q2'], delta: '42' });
  t.apply({ eventId: 'g3', rowPath: ['华北'], colPath: ['2025'], delta: 7 });
  t.apply({ eventId: 'g4', rowPath: ['华北'], colPath: ['2025'], delta: -7, correctionOf: 'g3' });
  t.apply({ eventId: 'g5', rowPath: ['华南'], colPath: ['2026'], delta: 7, correctionOf: 'g3' });

  const report = t.reconcile();
  assert.ok(report.ok, JSON.stringify(report.mismatches));
  assert.equal(report.grandTotal.tree, report.grandTotal.eventSum);
  assert.equal(report.grandTotal.eventSum, report.grandTotal.grouped);
  assert.equal(report.grandTotal.tree, 9007199254740993n + 42n + 7n);
  assert.equal(report.cellCounts.tree, report.cellCounts.grouped);
  assert.equal(report.emptyGroups.length, 1); // 华北×2025 迁空
  assert.equal(report.migrations.length, 1); // g3 链：华北×2025 → 华南×2026

  const out = t.build();
  const text = renderPivot(out);
  assert.ok(text.includes('NULL'));
  assert.ok(text.includes(`总计: ${9007199254740993n + 42n + 7n}`));
});
