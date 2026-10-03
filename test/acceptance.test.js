'use strict';
// 验收1：20 快照 × 5000 delta，注入坏块，restore 回退到最近可信点。
// 另覆盖：块缺失 code=50、seq 空洞 code=51、同 seq 不同内容冲突、更正/撤销语义。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'g17-acc-'));
}

test('20 snapshots x 5000 deltas, corrupt chunk -> restore falls back to nearest trusted point', () => {
  const dir = tmpdir();
  const accounts = ['a', 'b', 'c', 'd', 'e'];
  let model = {};
  const modelAtSnapshot = {};
  let seq = 0;
  const DELTAS_PER_SNAP = 250; // 20 x 250 = 5000
  for (let snap = 1; snap <= 20; snap++) {
    for (let k = 0; k < DELTAS_PER_SNAP; k++) {
      seq++;
      const acct = accounts[seq % accounts.length];
      const delta = ((seq * 37) % 91) - 45;
      store.appendDelta(dir, { seq, type: 'txn', ops: [{ account: acct, delta }] });
      model[acct] = (model[acct] || 0) + delta;
      if (model[acct] === 0) delete model[acct];
    }
    store.writeSnapshot(dir, model, { seq: snap, baseSeq: seq, chunkSize: 2 });
    modelAtSnapshot[snap] = { ...model };
  }
  assert.equal(seq, 5000);

  // 基线：全部可信时 restore 到快照 20。
  const base = store.restore(dir);
  assert.equal(base.snapshotSeq, 20);
  assert.equal(base.baseSeq, 5000);
  assert.deepEqual(base.balances, model);

  // 注入坏块：破坏快照 20 的一个分块。
  const chunkFile = path.join(dir, 'snapshots', 'seq-00000020', 'chunk-0000.json');
  fs.appendFileSync(chunkFile, 'CORRUPTED');

  const res = store.restore(dir);
  assert.equal(res.snapshotSeq, 19, 'falls back to snapshot 19');
  assert.equal(res.baseSeq, 19 * DELTAS_PER_SNAP);
  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0].code, 50, 'bad chunk reported with code=50');
  assert.equal(res.warnings[0].reason, 'chunk-corrupt');
  assert.equal(res.headSeq, 5000);
  // 回退后重放增量，最终余额仍等于全量模型。
  assert.deepEqual(res.balances, model);

  // 快照 19 也损坏 -> 回退到快照 18。
  fs.appendFileSync(path.join(dir, 'snapshots', 'seq-00000019', 'chunk-0001.json'), 'X');
  const res2 = store.restore(dir);
  assert.equal(res2.snapshotSeq, 18);
  assert.deepEqual(res2.balances, model);
});

test('missing chunk reported with code=50 and falls back', () => {
  const dir = tmpdir();
  store.appendDelta(dir, { seq: 1, type: 'txn', ops: [{ account: 'a', delta: 10 }] });
  store.writeSnapshot(dir, { a: 10 }, { seq: 1, baseSeq: 1, chunkSize: 1 });
  store.appendDelta(dir, { seq: 2, type: 'txn', ops: [{ account: 'a', delta: 5 }] });
  store.writeSnapshot(dir, { a: 15 }, { seq: 2, baseSeq: 2, chunkSize: 1 });
  fs.unlinkSync(path.join(dir, 'snapshots', 'seq-00000002', 'chunk-0000.json'));
  const res = store.restore(dir);
  assert.equal(res.warnings[0].code, 50);
  assert.equal(res.warnings[0].reason, 'chunk-missing');
  assert.equal(res.snapshotSeq, 1);
  assert.deepEqual(res.balances, { a: 15 });
});

test('seq gap in delta log -> code=51', () => {
  const dir = tmpdir();
  store.appendDelta(dir, { seq: 1, type: 'txn', ops: [{ account: 'a', delta: 1 }] });
  store.appendDelta(dir, { seq: 2, type: 'txn', ops: [{ account: 'a', delta: 1 }] });
  // 绕过 appendDelta 直接写入空洞 seq=4。
  fs.appendFileSync(path.join(dir, 'deltas.log'),
    store.canonical({ seq: 4, type: 'txn', ops: [{ account: 'a', delta: 1 }] }) + '\n');
  assert.throws(() => store.restore(dir), (err) => err.code === 51);
  // appendDelta 自身也拒绝跳号。
  assert.throws(() => store.appendDelta(dir, { seq: 9, type: 'txn', ops: [] }), (err) => err.code === 51);
});

test('same seq different content -> conflict (append & restore)', () => {
  const dir = tmpdir();
  const e1 = { seq: 1, type: 'txn', ops: [{ account: 'a', delta: 1 }] };
  store.appendDelta(dir, e1);
  // 同 seq 同内容：幂等成功。
  assert.deepEqual(store.appendDelta(dir, e1), { appended: false, seq: 1 });
  // 同 seq 不同内容：冲突。
  assert.throws(
    () => store.appendDelta(dir, { seq: 1, type: 'txn', ops: [{ account: 'a', delta: 2 }] }),
    (err) => err.code === 52,
  );
  // 日志被篡改出同 seq 不同内容：restore 也判冲突。
  fs.appendFileSync(path.join(dir, 'deltas.log'),
    store.canonical({ seq: 1, type: 'txn', ops: [{ account: 'a', delta: 2 }] }) + '\n');
  assert.throws(() => store.restore(dir), (err) => err.code === 52);
});

test('correct & undo with higher commitSeq override snapshot-covered positions', () => {
  const dir = tmpdir();
  store.appendDelta(dir, { seq: 1, type: 'txn', ops: [{ account: 'a', delta: 100 }] });
  store.appendDelta(dir, { seq: 2, type: 'txn', ops: [{ account: 'b', delta: 50 }] });
  store.writeSnapshot(dir, { a: 100, b: 50 }, { seq: 1, baseSeq: 2 });
  // 快照之后的更正/撤销（更高 commitSeq）回溯修正已折入快照的位点。
  store.appendDelta(dir, { seq: 3, type: 'correct', target: 1, ops: [{ account: 'a', delta: 70 }] });
  store.appendDelta(dir, { seq: 4, type: 'undo', target: 2 });
  store.appendDelta(dir, { seq: 5, type: 'txn', ops: [{ account: 'c', delta: 7 }] });
  const res = store.restore(dir);
  assert.equal(res.snapshotSeq, 1);
  assert.equal(res.baseSeq, 2);
  assert.deepEqual(res.balances, { a: 70, c: 7 });
});

test('no committed manifest -> only previous snapshot is trusted', () => {
  const dir = tmpdir();
  store.writeSnapshot(dir, { a: 1 }, { seq: 1, baseSeq: 0 });
  // 手工留下未提交的 manifest（只有 tmp，没有 rename）。
  const sdir = path.join(dir, 'snapshots', 'seq-00000002');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'chunk-0000.json'), store.canonical({ index: 0, accounts: { a: 2 } }));
  fs.writeFileSync(path.join(sdir, 'manifest.json.tmp'), '{}');
  const res = store.restore(dir);
  assert.equal(res.snapshotSeq, 1);
  assert.deepEqual(res.balances, { a: 1 });
});
