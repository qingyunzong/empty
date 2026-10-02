'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../src/lineage');
const R = require('../src/reference');
const cli = require('../src/cli');

// 场景1图谱：A 拆分为 B、C，再合并为 D，D 加工为 E。
function splitMergeState() {
  const state = L.emptyState();
  L.commit(state, {
    id: 'tx-build',
    corrections: [
      { kind: 'edge', old: null, new: { child: 'B', parent: 'A', quantity: 2 } },
      { kind: 'edge', old: null, new: { child: 'C', parent: 'A', quantity: 3 } },
      { kind: 'edge', old: null, new: { child: 'D', parent: 'B', quantity: 1 } },
      { kind: 'edge', old: null, new: { child: 'D', parent: 'C', quantity: 1 } },
      { kind: 'edge', old: null, new: { child: 'E', parent: 'D', quantity: 5 } },
    ],
  });
  return state;
}

test('场景1: split 后 merge，双向可达枚举与 DFS 参考一致', () => {
  const state = splitMergeState();
  const certE = L.certificate(state, 'E');
  assert.deepEqual(certE.upstream, ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(certE.roots, ['A']);
  const certA = L.certificate(state, 'A');
  assert.deepEqual(certA.downstream, ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(certA.leaves, ['E']);
  // 每个 lot 的递归闭包都与独立 DFS 枚举完全一致（双向）。
  for (const lot of ['A', 'B', 'C', 'D', 'E']) {
    assert.deepEqual(L.upstreamClosure(state.edges, lot), R.dfsUpstream(state.edges, lot), `upstream ${lot}`);
    assert.deepEqual(L.downstreamClosure(state.edges, lot), R.dfsDownstream(state.edges, lot), `downstream ${lot}`);
  }
});

test('缺失检验不得隐式判定合格', () => {
  const state = splitMergeState();
  assert.equal(L.certificate(state, 'E').status, 'uninspected');
  L.commit(state, {
    id: 'tx-insp',
    corrections: [
      { kind: 'inspection', old: null, new: { lot: 'A', result: 'pass', ts: 1 } },
      { kind: 'inspection', old: null, new: { lot: 'B', result: 'pass', ts: 1 } },
      { kind: 'inspection', old: null, new: { lot: 'C', result: 'pass', ts: 1 } },
      { kind: 'inspection', old: null, new: { lot: 'D', result: 'pass', ts: 1 } },
      { kind: 'inspection', old: null, new: { lot: 'E', result: 'pass', ts: 1 } },
    ],
  });
  assert.equal(L.certificate(state, 'E').status, 'passed');
});

test('场景2: 上游 null 检验更正为 block，uninspected -> blocked 且增量正确', () => {
  const state = splitMergeState();
  L.commit(state, {
    id: 'tx-null-insp',
    corrections: [
      { kind: 'inspection', old: null, new: { lot: 'A', result: null, ts: 1 } },
    ],
  });
  const before = L.certificate(state, 'E');
  assert.equal(before.status, 'uninspected');
  assert.deepEqual(before.blockedRecords, []);

  L.commit(state, {
    id: 'tx-fix',
    corrections: [
      { kind: 'inspection',
        old: { lot: 'A', result: null, ts: 1 },
        new: { lot: 'A', result: 'block', ts: 2 } },
    ],
  });
  const after = L.certificate(state, 'E');
  assert.equal(after.status, 'blocked');
  assert.deepEqual(after.blockedRecords, [{ lot: 'A', result: 'block', ts: 2 }]);
  // 增量正确：闭包与根/叶集合不变，仅阻塞集合与状态变化，版本与哈希前进。
  assert.deepEqual(after.upstream, before.upstream);
  assert.deepEqual(after.downstream, before.downstream);
  assert.deepEqual(after.roots, before.roots);
  assert.deepEqual(after.leaves, before.leaves);
  assert.equal(after.version, before.version + 1);
  assert.notEqual(after.inputHash, before.inputHash);

  // 撤销后精确恢复原闭包与阻塞集合。
  L.undo(state, 'tx-fix');
  const restored = L.certificate(state, 'E');
  assert.equal(restored.status, 'uninspected');
  assert.deepEqual(restored.blockedRecords, []);
  assert.deepEqual({ ...restored, version: before.version, inputHash: before.inputHash },
    { ...before, version: before.version, inputHash: before.inputHash });
});

test('场景3: 撤销不存在事务报错，重复撤销不改变状态', () => {
  const state = splitMergeState();
  assert.throws(() => L.undo(state, 'no-such-tx'), /transaction not found/);

  L.commit(state, {
    id: 'tx-block',
    corrections: [
      { kind: 'inspection', old: null, new: { lot: 'A', result: 'block', ts: 1 } },
    ],
  });
  const first = L.undo(state, 'tx-block');
  assert.equal(first.changed, true);
  const snapshot = JSON.stringify(state);
  const second = L.undo(state, 'tx-block');
  assert.equal(second.changed, false);
  assert.equal(JSON.stringify(state), snapshot); // 重复撤销幂等
});

test('边更正撤销后精确恢复原闭包', () => {
  const state = splitMergeState();
  const before = L.certificate(state, 'E');
  L.commit(state, {
    id: 'tx-rewire',
    corrections: [
      { kind: 'edge',
        old: { child: 'D', parent: 'C', quantity: 1 },
        new: { child: 'D', parent: 'C', quantity: 9 } },
    ],
  });
  L.undo(state, 'tx-rewire');
  const after = L.certificate(state, 'E');
  assert.deepEqual(after.upstream, before.upstream);
  assert.deepEqual(after.roots, before.roots);
  assert.equal(after.inputHash, before.inputHash); // version 不同但内容哈希中 version 字段除外？见下
});

test('CLI: trace/commit/undo 端到端', () => {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'db.json');
  const run = (...args) => {
    let out = '';
    let err = '';
    const code = cli.run(['--db', db, ...args], {
      stdout: (s) => { out += s; },
      stderr: (s) => { err += s; },
    });
    if (code !== 0) throw new Error(err.trim());
    return out.trim();
  };

  run('commit', JSON.stringify({
    id: 'tx1',
    corrections: [
      { kind: 'edge', old: null, new: { child: 'P', parent: 'R', quantity: 4 } },
      { kind: 'inspection', old: null, new: { lot: 'R', result: 'block', ts: 7 } },
    ],
  }));
  const cert = JSON.parse(run('trace', 'P'));
  assert.equal(cert.status, 'blocked');
  assert.deepEqual(cert.roots, ['R']);
  assert.deepEqual(cert.blockedRecords, [{ lot: 'R', result: 'block', ts: 7 }]);

  const undoOut = JSON.parse(run('undo', 'tx1'));
  assert.equal(undoOut.changed, true);
  const cert2 = JSON.parse(run('trace', 'P'));
  assert.equal(cert2.status, 'uninspected');
  assert.deepEqual(cert2.roots, ['P']); // 边已撤销，P 无父批次，自身为根

  assert.throws(() => run('undo', 'ghost'), /transaction not found/);
});
