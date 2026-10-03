import test from 'node:test';
import assert from 'node:assert/strict';
import { Cluster, ClusterError, visibleEntries } from '../src/cluster.js';

function nodeValues(node) {
  const out = {};
  for (const [k, e] of visibleEntries(node.entries.values())) out[k] = e.value;
  return out;
}

test('验收1: 3节点扩到5再缩到3，旧epoch写被拒', () => {
  const c = new Cluster();
  c.join('n1'); c.join('n2'); c.join('n3');
  const epoch3 = c.epoch;
  c.write({ key: 'temp', value: 20, node: 'n1' });

  c.join('n4'); c.join('n5'); // 扩到 5
  assert.equal(c.members.size, 5);
  assert.equal(c.quorumSize(), 3);
  const w5 = c.write({ key: 'temp', value: 21, node: 'n4' });
  assert.equal(w5.signers.length, 5);

  c.leave('n4'); c.leave('n5'); // 缩到 3
  assert.deepEqual([...c.members].sort(), ['n1', 'n2', 'n3']);
  assert.deepEqual([...c.tombstones].sort(), ['n4', 'n5']);
  // tombstone 历史可审计
  const log5 = c.membershipLog.find((m) => m.epoch === epoch3 + 2);
  assert.deepEqual(log5.members, ['n1', 'n2', 'n3', 'n4', 'n5']);

  // 旧 epoch 写被拒
  assert.throws(
    () => c.write({ key: 'temp', value: 99, node: 'n1', epoch: epoch3 }),
    (e) => e instanceof ClusterError && e.code === 'EPOCH_MISMATCH',
  );
  // tombstone 节点写被拒（不再计票）
  assert.throws(
    () => c.write({ key: 'temp', value: 99, node: 'n4' }),
    (e) => e instanceof ClusterError && e.code === 'NOT_MEMBER',
  );
  // 当前 epoch 正常写读
  const w = c.write({ key: 'temp', value: 23, node: 'n2' });
  assert.equal(w.signers.length, 3);
  const r = c.read({ key: 'temp' });
  assert.equal(r.value, 23);
  assert.equal(r.certificate.epoch, c.epoch);
  assert.deepEqual(r.certificate.signers, ['n1', 'n2', 'n3']);
});

test('验收2: 网络分区消息丢弃后多数派侧可恢复', () => {
  const c = new Cluster();
  ['a', 'b', 'c', 'd', 'e'].forEach((n) => c.join(n));
  c.write({ key: 'k', value: 'v1', node: 'a' });

  c.isolate(['d', 'e']); // 少数派分区，消息丢弃
  const w = c.write({ key: 'k', value: 'v2', node: 'a' });
  assert.deepEqual(w.signers, ['a', 'b', 'c']); // 多数派确认成功
  assert.equal(c.read({ key: 'k' }).value, 'v2'); // 多数派侧可读

  c.isolate(['b', 'c']); // 仅剩 a 可达，不足多数派
  assert.throws(
    () => c.write({ key: 'k', value: 'v3', node: 'a' }),
    (e) => e.code === 'QUORUM_FAIL',
  );
  assert.throws(() => c.read({ key: 'k' }), (e) => e.code === 'QUORUM_FAIL');

  c.heal(); // 分区恢复
  const w2 = c.write({ key: 'k2', value: 'ok', node: 'a' });
  assert.equal(w2.signers.length, 5); // 多数派侧恢复后全员可写
  c.repair();
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    assert.equal(nodeValues(c.nodes.get(id)).k, 'v2');
  }
});

test('验收3: repair 与暴力全量拷贝最终可见值一致', () => {
  const c = new Cluster();
  const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
  ids.forEach((n) => c.join(n));
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let i = 0; i < 60; i += 1) {
    c.heal();
    c.isolate(ids.filter(() => rand() < 0.3)); // 随机分区
    const key = `sensor${Math.floor(rand() * 4)}`;
    const node = ids[Math.floor(rand() * ids.length)];
    try {
      c.write({ key, value: i, node });
    } catch (e) {
      assert.ok(e instanceof ClusterError && (e.code === 'QUORUM_FAIL' || e.code === 'NOT_MEMBER'));
    }
  }
  c.heal();
  c.repair(); // 反熵：全员互相补齐

  // 暴力全量拷贝：把全集群所有 entry 合并求可见值
  const all = [];
  for (const n of c.nodes.values()) all.push(...n.entries.values());
  const expected = {};
  for (const [k, e] of visibleEntries(all)) expected[k] = e.value;

  for (const id of ids) {
    assert.deepEqual(nodeValues(c.nodes.get(id)), expected, `${id} 修复后与全量拷贝不一致`);
  }
  // 已确认因果序不变：修复幂等，再次 repair 无新增
  const again = c.repair();
  assert.ok(again.repaired.every((r) => r.filled === 0));
});

test('验收4: 重复join幂等', () => {
  const c = new Cluster();
  const j1 = c.join('n1');
  assert.equal(j1.idempotent, false);
  const epoch = c.epoch;
  const j2 = c.join('n1');
  const j3 = c.join('n1');
  assert.equal(j2.idempotent, true);
  assert.equal(j3.idempotent, true);
  assert.equal(j2.epoch, epoch);
  assert.equal(c.epoch, epoch); // 不产生新 epoch
  assert.equal(c.members.size, 1);
  assert.equal(c.membershipLog.length, 2); // 仅初始 + 首次 join
});
