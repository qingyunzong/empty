import test from 'node:test';
import assert from 'node:assert/strict';

import { SceneGraph } from '../dist/scene-graph.js';
import { transformAABB, IDENTITY } from '../dist/math.js';

const UNIT = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

/**
 * 构建宽树：
 * root
 *  ├─ main
 *  │   └─ child
 *  │       └─ leaf(geo)
 *  └─ side-1..sideN(每个带 geo，构成与 main 无关的支路)
 */
function buildWideTree(sideCount) {
  const graph = new SceneGraph();
  graph.geometries.register({ id: 'geo', localBounds: UNIT });
  const tx = graph.beginTransaction();
  tx.addNode('root', null, IDENTITY)
    .addNode('main', 'root', [2, 0, 0, 2, 0, 0])
    .addNode('child', 'main', IDENTITY)
    .addNode('leaf', 'child', [1, 0, 0, 1, 3, 4], 'geo');
  for (let i = 1; i <= sideCount; i++) {
    tx.addNode(`side-${i}`, 'root', IDENTITY, 'geo');
  }
  tx.commit();
  return graph;
}

test('全树重算遍历全部节点，作为参照基线', () => {
  const graph = buildWideTree(8);
  const total = graph.nodeCount(); // 4 主干 + 8 旁路 + root 已计入
  const stats = graph.recomputeFullTree();
  assert.equal(stats.fullWorldRecomputed, total);
  assert.equal(stats.fullAabbRecomputed, total);
});

test('局部变换的增量计数远小于全树，且无关旁路 AABB 保持不变', () => {
  const sideCount = 8;
  const graph = buildWideTree(sideCount);
  const total = graph.nodeCount();
  graph.recomputeFullTree();

  const sideBoxesBefore = new Map();
  for (let i = 1; i <= sideCount; i++) {
    sideBoxesBefore.set(`side-${i}`, graph.getSubtreeBounds(`side-${i}`));
  }

  graph.beginTransaction().setTransform('leaf', [5, 0, 0, 5, 0, 0]).commit();
  const stats = graph.getLastRecomputeStats();

  // 世界变换只重算 leaf 自己；AABB 重算 leaf/child/main/root 四个祖先链节点
  assert.equal(stats.worldRecomputed, 1);
  assert.equal(stats.aabbRecomputed, 4);
  assert.ok(stats.aabbRecomputed < total);

  for (let i = 1; i <= sideCount; i++) {
    assert.ok(!stats.touchedNodeIds.has(`side-${i}`));
    assert.deepEqual(
      graph.getSubtreeBounds(`side-${i}`),
      sideBoxesBefore.get(`side-${i}`),
    );
  }
});

test('换父只重算移动子树与两侧祖先链，不遍历兄弟支路', () => {
  const graph = buildWideTree(8);
  const total = graph.nodeCount();

  graph.beginTransaction().reparent('leaf', 'root').commit();
  const stats = graph.getLastRecomputeStats();

  // 移动子树只有 leaf；旧链 child/main/root 与新链 root 的 AABB 需要更新
  assert.equal(stats.worldRecomputed, 1);
  assert.ok(stats.aabbRecomputed <= 4);
  assert.ok(stats.aabbRecomputed < total);
  for (let i = 1; i <= 8; i++) {
    assert.ok(!stats.touchedNodeIds.has(`side-${i}`));
  }
  assert.equal(graph.getParentId('leaf'), 'root');
});

test('几何替换零世界重算，AABB 仅沿祖先链向上', () => {
  const graph = buildWideTree(4);
  graph.geometries.register({
    id: 'big',
    localBounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
  });

  graph.beginTransaction().setGeometry('leaf', 'big').commit();
  const stats = graph.getLastRecomputeStats();
  assert.equal(stats.worldRecomputed, 0);
  assert.equal(stats.aabbRecomputed, 4); // leaf, child, main, root
  const expectedLeaf = transformAABB(graph.getWorld('leaf'), {
    minX: -10,
    minY: -10,
    maxX: 10,
    maxY: 10,
  });
  assert.deepEqual(graph.getSubtreeBounds('leaf'), expectedLeaf);
});

test('累计计数随多次局部修改线性增长于受影响规模，而非全树规模', () => {
  const graph = buildWideTree(20);
  const total = graph.nodeCount();
  const start = graph.getCumulativeStats();

  for (let i = 0; i < 5; i++) {
    graph
      .beginTransaction()
      .setTransform('leaf', [1 + i, 0, 0, 1 + i, 0, 0])
      .commit();
  }

  const end = graph.getCumulativeStats();
  const worldDelta = end.worldRecomputed - start.worldRecomputed;
  const aabbDelta = end.aabbRecomputed - start.aabbRecomputed;
  assert.equal(worldDelta, 5); // 每次仅 leaf
  assert.equal(aabbDelta, 5 * 4); // 每次 4 个祖先链节点
  assert.ok(aabbDelta < 5 * total);
});
