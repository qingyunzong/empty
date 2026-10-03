'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const g = require(path.join(__dirname, '..', 'lib', 'genealogy.js'));
const cli = require(path.join(__dirname, '..', 'bin', 'cli.js'));

// 场景1数据：A 拆分为 B、C，再合并为 D
function splitMergeState() {
  return g.createState({
    edges: [
      { child: 'B', parent: 'A', quantity: 50 },
      { child: 'C', parent: 'A', quantity: 50 },
      { child: 'D', parent: 'B', quantity: 40 },
      { child: 'D', parent: 'C', quantity: 40 },
    ],
  });
}

test('场景1: split后再merge，双向可达枚举与参考DFS一致', () => {
  const state = splitMergeState();

  // 逆向追溯：D 的上游闭包与根集合
  assert.deepEqual([...g.ancestors(state, 'D')].sort(), ['A', 'B', 'C']);
  assert.deepEqual(g.roots(state, 'D'), ['A']);
  assert.deepEqual(g.leaves(state, 'D'), ['D']);

  // 正向追溯：A 的下游闭包与叶集合
  assert.deepEqual([...g.descendants(state, 'A')].sort(), ['B', 'C', 'D']);
  assert.deepEqual(g.roots(state, 'A'), ['A']);
  assert.deepEqual(g.leaves(state, 'A'), ['D']);

  // 中间批次视角
  assert.deepEqual(g.roots(state, 'B'), ['A']);
  assert.deepEqual(g.leaves(state, 'B'), ['D']);

  // 与独立 DFS 参考算法交叉验证（每个批次、两个方向）
  for (const lot of ['A', 'B', 'C', 'D']) {
    assert.deepEqual(
      [...g.ancestors(state, lot)].sort(),
      [...g.referenceReachable(state, lot, 'up')].sort(),
      `upstream mismatch for ${lot}`,
    );
    assert.deepEqual(
      [...g.descendants(state, lot)].sort(),
      [...g.referenceReachable(state, lot, 'down')].sort(),
      `downstream mismatch for ${lot}`,
    );
  }
});

test('场景2: 上游null检验更正为block，状态由uninspected变blocked且增量正确', () => {
  let state = splitMergeState();
  state = g.commit(state, {
    id: 'tx-insp-null',
    kind: 'inspection',
    old: null,
    new: { lot: 'A', result: null, ts: 1 },
  });

  const before = g.certificate(state, 'D');
  assert.equal(before.status, 'uninspected'); // null 不得隐式判定合格
  assert.deepEqual(before.blockedRecords, []);
  assert.deepEqual(before.roots, ['A']);

  // 更正：null -> block
  state = g.commit(state, {
    id: 'tx-insp-fix',
    kind: 'inspection',
    old: { lot: 'A', result: null, ts: 1 },
    new: { lot: 'A', result: 'block', ts: 2 },
  });

  const after = g.certificate(state, 'D');
  assert.equal(after.status, 'blocked');
  assert.deepEqual(after.blockedRecords, [{ lot: 'A', result: 'block', ts: 2 }]);
  assert.equal(after.version, before.version + 1); // 版本增量正确
  assert.notEqual(after.inputHash, before.inputHash);
  // 阻塞增量：恰好新增一条 block 记录
  assert.equal(after.blockedRecords.length - before.blockedRecords.length, 1);
  // 谱系闭包不受检验更正影响
  assert.deepEqual(after.roots, before.roots);
  assert.deepEqual(after.leaves, before.leaves);
});

test('场景2补充: 未检（缺失记录）同样为uninspected，pass则为pass', () => {
  const state = splitMergeState();
  assert.equal(g.certificate(state, 'D').status, 'uninspected'); // 完全无记录
  const passed = g.commit(state, {
    id: 'tx-pass',
    kind: 'inspection',
    old: null,
    new: { lot: 'A', result: 'pass', ts: 1 },
  });
  assert.equal(g.certificate(passed, 'D').status, 'pass');
});

test('场景3: 撤销不存在事务报错，重复撤销不改变状态', () => {
  let state = splitMergeState();
  state = g.commit(state, {
    id: 'tx-edge',
    kind: 'edge',
    old: { child: 'D', parent: 'C', quantity: 40 },
    new: { child: 'D', parent: 'C2', quantity: 40 },
  });
  const committed = g.certificate(state, 'D');
  assert.deepEqual(committed.roots, ['A', 'C2']);

  // 撤销不存在的事务 -> 报错
  assert.throws(() => g.undo(state, 'no-such-tx'), /transaction not found/);

  // 第一次撤销：精确恢复原闭包
  const first = g.undo(state, 'tx-edge');
  assert.equal(first.changed, true);
  const restored = g.certificate(first.state, 'D');
  assert.deepEqual(restored.roots, ['A']);
  assert.deepEqual([...g.ancestors(first.state, 'D')].sort(), ['A', 'B', 'C']);
  assert.deepEqual(restored.blockedRecords, []);

  // 重复撤销：幂等，状态完全不变
  const second = g.undo(first.state, 'tx-edge');
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, first.state);
});

test('撤销检验更正后精确恢复原阻塞集合与输入哈希', () => {
  let state = splitMergeState();
  state = g.commit(state, {
    id: 'tx-1',
    kind: 'inspection',
    old: null,
    new: { lot: 'B', result: 'block', ts: 10 },
  });
  const blockedCert = g.certificate(state, 'D');
  assert.equal(blockedCert.status, 'blocked');
  assert.deepEqual(blockedCert.blockedRecords, [{ lot: 'B', result: 'block', ts: 10 }]);

  const { state: restored } = g.undo(state, 'tx-1');
  const restoredCert = g.certificate(restored, 'D');
  assert.equal(restoredCert.status, 'uninspected');
  assert.deepEqual(restoredCert.blockedRecords, []);
  assert.equal(restoredCert.inputHash, g.inputHash(splitMergeState()));
});

test('重复提交相同活动事务id报错', () => {
  const state = splitMergeState();
  const committed = g.commit(state, {
    id: 'tx-dup',
    kind: 'inspection',
    old: null,
    new: { lot: 'A', result: 'pass', ts: 1 },
  });
  assert.throws(
    () => g.commit(committed, { id: 'tx-dup', kind: 'inspection', old: null, new: { lot: 'A', result: 'pass', ts: 2 } }),
    /duplicate active transaction id/,
  );
});

test('非法检验结果被拒绝（null/缺失不得隐式合格）', () => {
  const state = splitMergeState();
  assert.throws(
    () => g.commit(state, { id: 'tx-bad', kind: 'inspection', old: null, new: { lot: 'A', result: 'ok', ts: 1 } }),
    /result must be pass, block or null/,
  );
});

test('CLI: init/commit/trace/undo 全流程', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genealogy-'));
  const stateFile = path.join(dir, 'state.json');
  const run = (args) => cli.run(args);

  run(['init', '--state', stateFile]);
  run(['commit', '--state', stateFile, '--tx', JSON.stringify({ id: 'e1', kind: 'edge', old: null, new: { child: 'B', parent: 'A', quantity: 50 } })]);
  run(['commit', '--state', stateFile, '--tx', JSON.stringify({ id: 'e2', kind: 'edge', old: null, new: { child: 'C', parent: 'A', quantity: 50 } })]);
  run(['commit', '--state', stateFile, '--tx', JSON.stringify({ id: 'e3', kind: 'edge', old: null, new: { child: 'D', parent: 'B', quantity: 40 } })]);
  run(['commit', '--state', stateFile, '--tx', JSON.stringify({ id: 'e4', kind: 'edge', old: null, new: { child: 'D', parent: 'C', quantity: 40 } })]);

  const cert = run(['trace', '--state', stateFile, '--lot', 'D']);
  assert.equal(cert.status, 'uninspected');
  assert.deepEqual(cert.roots, ['A']);
  assert.deepEqual(cert.leaves, ['D']);

  run(['commit', '--state', stateFile, '--tx', JSON.stringify({ id: 'i1', kind: 'inspection', old: null, new: { lot: 'A', result: 'block', ts: 7 } })]);
  const blocked = run(['trace', '--state', stateFile, '--lot', 'D']);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.blockedRecords, [{ lot: 'A', result: 'block', ts: 7 }]);

  const undoResult = run(['undo', '--state', stateFile, '--tx-id', 'i1']);
  assert.equal(undoResult.changed, true);
  const restored = run(['trace', '--state', stateFile, '--lot', 'D']);
  assert.equal(restored.status, 'uninspected');

  // 撤销不存在的事务 -> 报错
  assert.throws(() => run(['undo', '--state', stateFile, '--tx-id', 'nope']), /transaction not found/);
  // 重复撤销 -> changed=false，状态不变
  const again = run(['undo', '--state', stateFile, '--tx-id', 'i1']);
  assert.equal(again.changed, false);
  const still = run(['trace', '--state', stateFile, '--lot', 'D']);
  assert.deepEqual(still, restored);
});
