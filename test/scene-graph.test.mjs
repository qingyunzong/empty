import test from 'node:test';
import assert from 'node:assert/strict';

import { SceneGraph } from '../dist/scene-graph.js';
import { multiply, transformAABB, IDENTITY } from '../dist/math.js';

const UNIT = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

function matClose(actual, expected, epsilon = 1e-12) {
  assert.equal(actual.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= epsilon,
      `mat[${i}] ${actual[i]} != ${expected[i]}`,
    );
  }
}

function boxClose(actual, expected, epsilon = 1e-12) {
  for (const key of ['minX', 'minY', 'maxX', 'maxY']) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) <= epsilon,
      `${key}: ${actual[key]} != ${expected[key]}`,
    );
  }
}

/**
 * 构建测试树：
 * root
 *  ├─ A
 *  │   ├─ A1
 *  │   └─ A2
 *  └─ B
 *      └─ B1
 */
function buildGraph() {
  const graph = new SceneGraph();
  graph.geometries.register({ id: 'geo', localBounds: UNIT });
  graph.geometries.register({ id: 'other', localBounds: UNIT });
  const tx = graph.beginTransaction();
  tx.addNode('root', null, IDENTITY)
    .addNode('A', 'root', [2, 0, 0, 2, 10, 0])
    .addNode('B', 'root', [1, 0, 0, 1, 0, 5])
    .addNode('A1', 'A', [1, 0, 0, 1, 1, 1], 'geo')
    .addNode('A2', 'A', IDENTITY)
    .addNode('B1', 'B', IDENTITY, 'geo');
  tx.commit();
  return graph;
}

test('提交后世界变换沿父子链累乘', () => {
  const graph = buildGraph();
  // A1.world = A.local * A1.local
  matClose(graph.getWorld('A1'), [2, 0, 0, 2, 12, 2]);
  matClose(graph.getWorld('A2'), [2, 0, 0, 2, 10, 0]);
  matClose(graph.getWorld('B1'), [1, 0, 0, 1, 0, 5]);
});

test('单节点局部变换只重算该子树，不触及无关支路', () => {
  const graph = buildGraph();
  const before = graph.getCumulativeStats();
  const snapshot = graph
    .beginTransaction()
    .setTransform('A1', [3, 0, 0, 3, 0, 0])
    .commit();

  const stats = graph.getLastRecomputeStats();
  assert.deepEqual([...stats.touchedNodeIds].sort(), ['A', 'A1', 'root']);
  assert.equal(stats.worldRecomputed, 1); // 仅 A1
  assert.equal(stats.aabbRecomputed, 3); // A1 及其祖先 A、root

  // B 支路完全未参与重算
  assert.ok(!stats.touchedNodeIds.has('B'));
  assert.ok(!stats.touchedNodeIds.has('B1'));

  const after = graph.getCumulativeStats();
  assert.equal(after.worldRecomputed - before.worldRecomputed, 1);

  // 世界矩阵确实更新
  matClose(graph.getWorld('A1'), multiply(graph.getWorld('A'), [3, 0, 0, 3, 0, 0]));
  assert.equal(snapshot.version, graph.currentVersion());
});

test('剪切局部矩阵产出非等宽 AABB 且沿祖先传播', () => {
  const graph = buildGraph();
  graph
    .beginTransaction()
    .setGeometry('A2', 'geo')
    .setTransform('A2', [1, 0, 1, 1, 0, 0]) // x' = x + y
    .commit();

  const expectedA2 = multiply(graph.getWorld('A'), [1, 0, 1, 1, 0, 0]);
  matClose(graph.getWorld('A2'), expectedA2);
  const a2Box = graph.getSubtreeBounds('A2');
  boxClose(a2Box, transformAABB(expectedA2, UNIT));
  // 剪切使宽度由 2 扩张到 4
  assert.equal(a2Box.maxX - a2Box.minX, 4);
  assert.equal(a2Box.maxY - a2Box.minY, 2);

  // root 子树盒包含 A1 与 A2 两支
  const rootBox = graph.getSubtreeBounds('root');
  assert.ok(rootBox.maxX >= a2Box.maxX);
});

test('负缩放包围盒 min/max 正确翻转', () => {
  const graph = buildGraph();
  graph
    .beginTransaction()
    .setTransform('A1', [-1, 0, 0, 1, 0, 0])
    .commit();
  const box = graph.getSubtreeBounds('A1');
  assert.ok(box.minX < box.maxX);
  const expected = transformAABB(graph.getWorld('A1'), UNIT);
  boxClose(box, expected);
  // A 平移 x=10 后负缩放：局部 [0,1] 映射到世界 [8,10]
  assert.equal(box.minX, 8);
  assert.equal(box.maxX, 10);
});

test('同一几何被多处共享，替换与删除只调整引用计数', () => {
  const graph = buildGraph();
  assert.equal(graph.geometries.refInfo('geo').liveRefs, 2); // A1 与 B1

  graph.beginTransaction().setGeometry('B1', 'other').commit();
  assert.equal(graph.geometries.refInfo('geo').liveRefs, 1);
  assert.equal(graph.geometries.refInfo('other').liveRefs, 1);

  graph.beginTransaction().setGeometry('A1', null).commit();
  // 已保留的历史版本仍持有 geo，故暂不回收
  assert.equal(graph.geometries.has('geo'), true);
  assert.equal(graph.geometries.refInfo('geo').liveRefs, 0);
  assert.ok(graph.geometries.refInfo('geo').versionRefs > 0);

  // AABB 重算只涉及 A1/A/root，不遍历 B 支路
  const stats = graph.getLastRecomputeStats();
  assert.ok(!stats.touchedNodeIds.has('B'));
  assert.ok(!stats.touchedNodeIds.has('B1'));
  assert.equal(stats.worldRecomputed, 0); // 纯几何修改不重算世界变换
});

test('删除子树释放整棵子树的 live 几何引用', () => {
  const graph = buildGraph();
  graph.beginTransaction().removeNode('B').commit();
  assert.equal(graph.hasNode('B'), false);
  assert.equal(graph.hasNode('B1'), false);
  assert.equal(graph.geometries.refInfo('geo').liveRefs, 1); // 仅剩 A1
  assert.deepEqual(graph.getChildIds('root'), ['A']);
});

test('同批先把后代移出再删树根，后代存活且不被误删', () => {
  const graph = buildGraph();
  graph
    .beginTransaction()
    .reparent('B1', 'root')
    .removeNode('B')
    .commit();
  assert.equal(graph.hasNode('B'), false);
  assert.equal(graph.hasNode('B1'), true);
  assert.equal(graph.getParentId('B1'), 'root');
  // geo 仍被 A1 与 B1 引用
  assert.equal(graph.geometries.refInfo('geo').liveRefs, 2);
});

test('禁止把节点挂入将被删除的子树', () => {
  const graph = buildGraph();
  assert.throws(
    () =>
      graph
        .beginTransaction()
        .reparent('A1', 'B1') // B1 随 B 一起删除
        .removeNode('B')
        .commit(),
    /removed/,
  );
  assert.equal(graph.getParentId('A1'), 'A');
  assert.equal(graph.hasNode('B'), true);
});

test('祖孙同时换父在同一批次内原子生效', () => {
  const graph = buildGraph();
  // A1 改挂到 root，同时其孙辈关系中的 A2 改挂到 A1
  graph
    .beginTransaction()
    .reparent('A1', 'root')
    .reparent('A2', 'A1')
    .commit();

  assert.equal(graph.getParentId('A1'), 'root');
  assert.equal(graph.getParentId('A2'), 'A1');
  assert.deepEqual(graph.getChildIds('A').sort(), []);
  assert.deepEqual(graph.getChildIds('A1').sort(), ['A2']);

  // A1 现在直接相对 root：world == local
  matClose(graph.getWorld('A1'), [1, 0, 0, 1, 1, 1]);
  matClose(graph.getWorld('A2'), [1, 0, 0, 1, 1, 1]);

  const stats = graph.getLastRecomputeStats();
  // 移动子树 A1（含新后代 A2）与 A 的 AABB 祖先链都受影响，B 支路无关
  assert.ok(stats.touchedNodeIds.has('A1'));
  assert.ok(stats.touchedNodeIds.has('A2'));
  assert.ok(!stats.touchedNodeIds.has('B'));
  assert.ok(!stats.touchedNodeIds.has('B1'));
});

test('成环导致整批拒绝，图状态与计数完全不变', () => {
  const graph = buildGraph();
  const versionBefore = graph.currentVersion();
  const worldBefore = graph.getWorld('A');
  const refsBefore = { ...graph.geometries.refInfo('geo') };
  const rejectsBefore = graph.getCumulativeStats().rejectedCommits;

  assert.throws(
    () =>
      graph
        .beginTransaction()
        .reparent('root', 'A1') // root 成为 A1 后代 => 环
        .setTransform('A1', [9, 0, 0, 9, 0, 0])
        .commit(),
    /cycle/,
  );

  assert.equal(graph.currentVersion(), versionBefore);
  matClose(graph.getWorld('A'), worldBefore);
  assert.deepEqual(graph.geometries.refInfo('geo'), refsBefore);
  assert.equal(graph.getParentId('A1'), 'A');
  assert.equal(
    graph.getCumulativeStats().rejectedCommits,
    rejectsBefore + 1,
  );
});

test('自环（节点挂到自己）同样被拒绝', () => {
  const graph = buildGraph();
  assert.throws(
    () => graph.beginTransaction().reparent('A', 'A').commit(),
    /cycle/,
  );
});

test('固定版本快照不受后续提交影响，释放后几何按版本回收', () => {
  const graph = buildGraph();
  const pinned = graph.currentVersion();
  const oldA1 = graph.getVersion(pinned).getNode('A1');
  assert.equal(oldA1.geometryId, 'geo');

  graph.beginTransaction().setGeometry('A1', null).commit();
  graph.beginTransaction().removeNode('B1').commit();

  // 旧版本内容不变
  const pinnedAgain = graph.getVersion(pinned).getNode('A1');
  assert.equal(pinnedAgain.geometryId, 'geo');
  assert.deepEqual([...pinnedAgain.world], [...oldA1.world]);
  // 活图已改变
  assert.equal(graph.getGeometryId('A1'), null);

  // 释放除最早版本外的全部版本，geo 仍被 pinned 版本持有
  for (let v = graph.currentVersion(); v > pinned; v--) {
    graph.releaseVersion(v);
  }
  assert.equal(graph.geometries.has('geo'), true);

  graph.releaseVersion(pinned);
  // live 与所有版本引用均归零
  assert.equal(graph.geometries.has('geo'), false);
  assert.throws(() => graph.getVersion(pinned), /released|does not exist/);
});

test('空提交也产生新版本且零重算', () => {
  const graph = buildGraph();
  const v = graph.currentVersion();
  graph.beginTransaction().commit();
  assert.equal(graph.currentVersion(), v + 1);
  const stats = graph.getLastRecomputeStats();
  assert.equal(stats.worldRecomputed, 0);
  assert.equal(stats.aabbRecomputed, 0);
});
