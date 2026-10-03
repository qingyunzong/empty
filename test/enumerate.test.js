'use strict';
// 验收3：n<=12 枚举快照+delta 全部组合，restore 结果对照内存模型余额。
// 对每条长度 n 的操作序列（2^n 种，bit=1 快照 / bit=0 delta），
// 在独立数据目录执行后 restore，余额必须与顺序应用的内存模型一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');

const N_MAX = 12;

function runCombo(mask, n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g17-enum-'));
  try {
    const model = {};
    let deltaSeq = 0;
    let snapSeq = 0;
    let lastSnap = null; // {snapSeq, baseSeq}
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) {
        snapSeq++;
        store.writeSnapshot(dir, model, { seq: snapSeq, baseSeq: deltaSeq });
        lastSnap = { snapSeq, baseSeq: deltaSeq };
      } else {
        deltaSeq++;
        const account = 'acct' + (deltaSeq % 3);
        const delta = ((deltaSeq * 7 + n) % 11) - 5;
        store.appendDelta(dir, { seq: deltaSeq, type: 'txn', ops: [{ account, delta }] });
        model[account] = (model[account] || 0) + delta;
        if (model[account] === 0) delete model[account];
      }
    }
    const res = store.restore(dir);
    assert.deepEqual(res.balances, model, `mask=${mask} n=${n}`);
    if (lastSnap) {
      assert.equal(res.snapshotSeq, lastSnap.snapSeq);
      assert.equal(res.baseSeq, lastSnap.baseSeq);
    } else {
      assert.equal(res.snapshotSeq, 0, '无快照时从创世重放');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('enumerate all snapshot+delta combos for n<=12 and compare balances', { timeout: 600000 }, () => {
  let total = 0;
  for (let n = 1; n <= N_MAX; n++) {
    for (let mask = 0; mask < (1 << n); mask++) {
      runCombo(mask, n);
      total++;
    }
  }
  assert.equal(total, 2 ** (N_MAX + 1) - 2); // 8190 种组合
});
