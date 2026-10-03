'use strict';
// 验收2：kill 在 manifest fsync 前后分别验证两种恢复结果。
// 崩溃通过 crashHook 在精确的持久化边界抛出 SimulatedCrash 模拟：
// writeSnapshot 不做任何内存记账，抛出即等价于进程在该点死亡
// （之前已 fsync 的数据保留，之后的写入不发生），restore 仅依据磁盘状态恢复。
// （本运行环境禁止 node 派生子进程，CLI 的 SNAPSHOT_CRASH 环境变量可在真实
//   环境中以 SIGKILL 子进程方式复现同样的两个崩溃点。）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');

class SimulatedCrash extends Error {}

function crashAt(point) {
  return (at) => { if (at === point) throw new SimulatedCrash('killed at ' + at); };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'g17-crash-'));
}

// 快照1 (baseSeq=0) + delta 1..5 + 快照2 (baseSeq=5) + delta 6..10。
function setup(dir) {
  store.writeSnapshot(dir, { a: 1000, b: 500 }, { seq: 1, baseSeq: 0 });
  const bal = { a: 1000, b: 500 };
  for (let s = 1; s <= 5; s++) {
    store.appendDelta(dir, { seq: s, type: 'txn', ops: [{ account: 'a', delta: -s }, { account: 'b', delta: s }] });
    bal.a -= s; bal.b += s;
  }
  store.writeSnapshot(dir, { ...bal }, { seq: 2, baseSeq: 5 });
  for (let s = 6; s <= 10; s++) {
    store.appendDelta(dir, { seq: s, type: 'txn', ops: [{ account: 'a', delta: -s }, { account: 'b', delta: s }] });
    bal.a -= s; bal.b += s;
  }
  return bal; // 快照3 应包含的最终余额
}

test('kill before manifest fsync commit -> manifest 未提交，restore 只用上一快照', () => {
  const dir = tmpdir();
  setup(dir);
  const finalBal = { a: 1000 - 55, b: 500 + 55 };
  assert.throws(
    () => store.writeSnapshot(dir, finalBal, { seq: 3, baseSeq: 10, crashHook: crashAt('afterManifestFsync') }),
    (err) => err instanceof SimulatedCrash,
  );
  // tmp 已 fsync 但未 rename：manifest.json.tmp 在，manifest.json 不在。
  const sdir = path.join(dir, 'snapshots', 'seq-00000003');
  assert.ok(fs.existsSync(path.join(sdir, 'manifest.json.tmp')), 'tmp manifest left behind');
  assert.ok(!fs.existsSync(path.join(sdir, 'manifest.json')), 'manifest not committed');

  const res = store.restore(dir);
  assert.equal(res.snapshotSeq, 2, '回退到上一可信快照');
  assert.equal(res.baseSeq, 5);
  assert.equal(res.headSeq, 10);
  assert.deepEqual(res.balances, finalBal, '快照2 + delta 6..10 重放得到最终余额');
});

test('kill after manifest commit -> manifest 已提交，新快照可信', () => {
  const dir = tmpdir();
  setup(dir);
  const finalBal = { a: 1000 - 55, b: 500 + 55 };
  assert.throws(
    () => store.writeSnapshot(dir, finalBal, { seq: 3, baseSeq: 10, crashHook: crashAt('afterCommit') }),
    (err) => err instanceof SimulatedCrash,
  );
  assert.ok(fs.existsSync(path.join(dir, 'snapshots', 'seq-00000003', 'manifest.json')), 'manifest committed');

  const res = store.restore(dir);
  assert.equal(res.snapshotSeq, 3, '新快照可信');
  assert.equal(res.baseSeq, 10);
  assert.deepEqual(res.balances, finalBal);
});

test('kill before manifest write -> 快照3 无 manifest 痕迹，restore 不受影响', () => {
  const dir = tmpdir();
  setup(dir);
  const finalBal = { a: 1000 - 55, b: 500 + 55 };
  assert.throws(
    () => store.writeSnapshot(dir, finalBal, { seq: 3, baseSeq: 10, crashHook: crashAt('beforeManifestWrite') }),
    (err) => err instanceof SimulatedCrash,
  );
  const res = store.restore(dir);
  assert.equal(res.snapshotSeq, 2);
  assert.deepEqual(res.balances, finalBal);
});
