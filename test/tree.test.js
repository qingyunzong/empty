import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BondTree } from '../src/tree.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bond-')), 'data.json');
}

// 三层树：root -> mid -> leaf
function buildThreeLevel(file = null) {
  const t = new BondTree(file);
  t.addNode({ id: 'root', lineLimit: 1000, terms: '国债 分销 总额度' });
  t.addNode({ id: 'mid', parentId: 'root', lineLimit: 600, terms: '华东区 承销团 可提前 赎回 条款' });
  t.addNode({ id: 'leaf', parentId: 'mid', lineLimit: 300, terms: '某券商 分销点 提前 赎回 咨询' });
  return t;
}

test('验收1：三层补偿每层结果与独立后序遍历计算一致', () => {
  const t = buildThreeLevel();
  assert.equal(t.allocate('leaf', 200).ok, true);
  assert.equal(t.allocate('mid', 100).ok, true);
  // 撤销前：独立后序遍历基线
  const before = t.postOrderOccupied();
  assert.deepEqual([...before.entries()].sort(), [['leaf', 200], ['mid', 300], ['root', 300]]);

  const r = t.revoke('leaf', 120);
  assert.equal(r.ok, true);
  const cert = r.certificate;

  // 撤销后：独立后序遍历重算，与缓存占用及证书逐层对照
  const after = t.postOrderOccupied();
  assert.equal(cert.levels.length, 3);
  for (const lvl of cert.levels) {
    assert.equal(lvl.before, before.get(lvl.id), `before @ ${lvl.id}`);
    assert.equal(lvl.after, after.get(lvl.id), `after @ ${lvl.id}`);
    assert.equal(lvl.before - lvl.after, 120, `release @ ${lvl.id}`);
    assert.equal(t.getNode(lvl.id).occupied, after.get(lvl.id), `cached @ ${lvl.id}`);
  }
  assert.deepEqual(cert.levels.map((l) => l.id), ['leaf', 'mid', 'root']);

  // 证书哈希链可验证
  const { hash, ...body } = cert;
  const expectHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  assert.equal(hash, expectHash);
  assert.equal(t.rootCertHash(), hash);
});

test('验收2：某层额度不足时整树无变化', () => {
  const t = buildThreeLevel();
  t.allocate('leaf', 200);
  t.allocate('root', 50);
  t.revoke('mid', 150); // mid=50, root=100, leaf=200
  const snapshotBefore = JSON.stringify(t.listNodes());
  const headBefore = t.rootCertHash();

  const r = t.revoke('leaf', 120); // leaf=200 够，mid=50 不足 -> 全部不变
  assert.equal(r.ok, false);
  assert.match(r.error, /insufficient occupancy at level mid/);
  assert.equal(JSON.stringify(t.listNodes()), snapshotBefore, '整树无变化');
  assert.equal(t.rootCertHash(), headBefore, '证书链头不变');
  const occ = t.postOrderOccupied();
  for (const [id, v] of occ) assert.equal(t.getNode(id).occupied, v);
});

test('验收3a：删除有存活子节点的节点失败', () => {
  const t = buildThreeLevel();
  const r = t.deleteNode('mid');
  assert.equal(r.ok, false);
  assert.match(r.error, /live children/);
  assert.ok(t.getNode('mid'));
  assert.ok(t.findByPhrase('可提前 赎回').has('mid'), '索引仍保留');
});

test('验收3b：无子节点删除后重启不可见，位置增量移除', () => {
  const file = tmpFile();
  const t = buildThreeLevel(file);
  assert.ok(t.findByPhrase('提前 赎回 咨询').has('leaf'));

  const r = t.deleteNode('leaf');
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed, ['leaf']);
  assert.equal(t.getNode('leaf'), null);
  assert.ok(!t.findByPhrase('提前 赎回 咨询').has('leaf'), '删除后短语不命中');
  assert.ok(!t.findNear('提前 赎回', 3).has('leaf'), '删除后近邻不命中');
  assert.ok(t.findByPhrase('可提前 赎回').has('mid'), '其他节点不受影响');

  // 重启（重新加载同一数据文件）
  const t2 = new BondTree(file);
  assert.equal(t2.getNode('leaf'), null, '重启后节点不可见');
  assert.ok(!t2.findByPhrase('提前 赎回 咨询').has('leaf'), '重启后索引不可见');
  assert.equal(t2.getNode('mid').id, 'mid');
  assert.equal(t2.rootCertHash(), t.rootCertHash(), '证书链头持久化');
});

test('撤销后占用归零的节点变为 revoked，不再阻塞父节点删除', () => {
  const t = buildThreeLevel();
  t.allocate('leaf', 100);
  t.revoke('leaf', 100);
  assert.equal(t.getNode('leaf').state, 'revoked');
  const r = t.deleteNode('mid'); // leaf 非存活，级联移除
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed.sort(), ['leaf', 'mid']);
});

test('近邻定位条款相关节点并撤销，证书含命中位置', () => {
  const t = buildThreeLevel();
  t.allocate('mid', 80);
  t.allocate('leaf', 40);
  const expectedHits = t.findNear('提前 赎回', 5);
  assert.deepEqual([...expectedHits.keys()].sort(), ['leaf', 'mid']);
  const r = t.revokeByNear('提前 赎回', 5, 30);
  assert.equal(r.ok, true);
  assert.equal(r.certificates.length, 2);
  for (const cert of r.certificates) {
    assert.deepEqual(cert.hits, expectedHits.get(cert.nodeId), `命中位置 @ ${cert.nodeId}`);
    assert.ok(cert.hits.length > 0, '证书含命中位置');
  }
  const byNode = Object.fromEntries(r.certificates.map((c) => [c.nodeId, c]));
  assert.deepEqual(byNode.mid.levels.map((l) => l.id), ['mid', 'root']);
  assert.deepEqual(byNode.leaf.levels.map((l) => l.id), ['leaf', 'mid', 'root']);
  assert.equal(t.getNode('leaf').occupied, 10);
  assert.equal(t.getNode('mid').occupied, 60);
  assert.equal(t.getNode('root').occupied, 60);
  // 与独立后序遍历一致
  const occ = t.postOrderOccupied();
  for (const [id, v] of occ) assert.equal(t.getNode(id).occupied, v);
});

test('分配超额时整树不变', () => {
  const t = buildThreeLevel();
  t.allocate('leaf', 200);
  const before = JSON.stringify(t.listNodes());
  const r = t.allocate('leaf', 150); // leaf 上限 300，超出
  assert.equal(r.ok, false);
  assert.match(r.error, /line limit exceeded at level leaf/);
  assert.equal(JSON.stringify(t.listNodes()), before);
});
