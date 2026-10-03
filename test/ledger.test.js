'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EXIT_OK,
  EXIT_CONFLICT,
  EXIT_USAGE,
  LedgerError,
  GENESIS_HASH,
  stableStringify,
  stateHashOf,
  createLedger,
  stateOf,
  apply,
  undo,
  redo,
  seal,
  rewrite,
  main,
} = require('../index.js');


function applyAll(ledger, patches) {
  for (const p of patches) apply(ledger, p);
}

// ---------- 验收 1：apply / undo / redo ----------

test('apply/undo/redo 后状态与游标正确', () => {
  const ledger = createLedger();
  apply(ledger, { key: 'a', old: null, new: 1 });
  apply(ledger, { key: 'a', old: 1, new: 2 });
  apply(ledger, { key: 'b', old: null, new: 'x' });
  assert.equal(ledger.cursor, 3);
  assert.deepEqual(stateOf(ledger), { a: 2, b: 'x' });

  assert.equal(undo(ledger), true);
  assert.equal(ledger.cursor, 2);
  assert.deepEqual(stateOf(ledger), { a: 2 });

  assert.equal(undo(ledger), true);
  assert.equal(undo(ledger), true);
  assert.equal(ledger.cursor, 0);
  assert.deepEqual(stateOf(ledger), {});
  assert.equal(undo(ledger), false, '游标为 0 时 undo 无效');
  assert.equal(ledger.records.length, 3, 'undo 不删除历史');

  assert.equal(redo(ledger), true);
  assert.equal(redo(ledger), true);
  assert.equal(ledger.cursor, 2);
  assert.deepEqual(stateOf(ledger), { a: 2 });
  assert.equal(redo(ledger), true);
  assert.equal(redo(ledger), false, '游标到顶后 redo 无效');
  assert.deepEqual(stateOf(ledger), { a: 2, b: 'x' });
});

test('redo 被新 apply 打断后旧分支不可恢复', () => {
  const ledger = createLedger();
  applyAll(ledger, [
    { key: 'a', old: null, new: 1 },
    { key: 'a', old: 1, new: 2 },
    { key: 'a', old: 2, new: 3 },
  ]);
  undo(ledger);
  undo(ledger);
  assert.equal(ledger.cursor, 1);

  apply(ledger, { key: 'b', old: null, new: 9 });
  assert.equal(ledger.cursor, 2);
  assert.equal(ledger.records.length, 2, '新 apply 截断可 redo 的尾部');
  assert.equal(redo(ledger), false, '旧分支不可恢复');
  assert.deepEqual(stateOf(ledger), { a: 1, b: 9 });
  assert.equal(ledger.records[1].patch.key, 'b');
});

test('apply 守卫失败返回冲突码且不改变账本', () => {
  const ledger = createLedger();
  apply(ledger, { key: 'a', old: null, new: 1 });
  const before = JSON.stringify(ledger);
  assert.throws(
    () => apply(ledger, { key: 'a', old: 5, new: 6 }),
    (err) => err instanceof LedgerError && err.code === EXIT_CONFLICT &&
      err.details.expected === 5 && err.details.actual === 1,
  );
  assert.equal(JSON.stringify(ledger), before);
});

// ---------- 验收 2：重写中间值且无守卫冲突 ----------

test('重写中间提交：后继全部重放且哈希更新', () => {
  const ledger = createLedger();
  applyAll(ledger, [
    { key: 'a', old: null, new: 1 },
    { key: 'b', old: null, new: 5 },
    { key: 'c', old: null, new: 7 },
    { key: 'a', old: 1, new: 2 },
  ]);
  const oldHashes = ledger.records.map((r) => r.hash);

  const { ledger: out, hashMap } = rewrite(ledger, 2, { key: 'b', old: null, new: 6 });

  assert.deepEqual(stateOf(out), { a: 2, b: 6, c: 7 }, '后继全部重放');
  assert.equal(out.records.length, 4);
  assert.equal(out.cursor, 4);

  assert.equal(out.records[0].hash, oldHashes[0], '重写点之前的记录不变');
  assert.equal(hashMap[oldHashes[0]], undefined, '未变的哈希不出现在映射中');
  for (let i = 1; i < 4; i++) {
    assert.notEqual(out.records[i].hash, oldHashes[i], `记录 ${i + 1} 哈希已更新`);
    assert.equal(hashMap[oldHashes[i]], out.records[i].hash, '旧哈希映射到新哈希');
  }
  assert.equal(Object.keys(hashMap).length, 3);

  assert.equal(out.records[1].prevHash, oldHashes[0], 'prevHash 链保持连续');
  for (let i = 2; i < 4; i++) assert.equal(out.records[i].prevHash, out.records[i - 1].hash);
  for (let i = 1; i < 4; i++) {
    const state = {};
    for (let j = 0; j <= i; j++) {
      const p = out.records[j].patch;
      if (p.new === null) delete state[p.key]; else state[p.key] = p.new;
    }
    assert.equal(out.records[i].stateHash, stateHashOf(state), `记录 ${i + 1} stateHash 正确`);
  }
  assert.deepEqual(out.records[1].inverse, { key: 'b', old: 6, new: null }, '逆补丁同步更新');

  assert.equal(ledger.records[1].patch.new, 5, '原账本不被修改');
  assert.deepEqual(ledger.records.map((r) => r.hash), oldHashes);
});

// ---------- 验收 3：后继 old 不匹配 ----------

test('后继守卫冲突：报告首个失败点，原账本不变', () => {
  const ledger = createLedger();
  applyAll(ledger, [
    { key: 'a', old: null, new: 1 },
    { key: 'a', old: 1, new: 2 },
    { key: 'a', old: 2, new: 3 },
    { key: 'a', old: 3, new: 4 },
  ]);
  const before = JSON.stringify(ledger);

  assert.throws(
    () => rewrite(ledger, 2, { key: 'a', old: 1, new: 5 }),
    (err) => err instanceof LedgerError && err.code === EXIT_CONFLICT &&
      err.details.seq === 3 && err.details.expected === 2 && err.details.actual === 5,
    '报告首个失败点（第 3 条）',
  );
  assert.equal(JSON.stringify(ledger), before, '失败不得替换原账本');
});

test('被重写提交自身的 old 守卫不匹配也算冲突', () => {
  const ledger = createLedger();
  applyAll(ledger, [
    { key: 'a', old: null, new: 1 },
    { key: 'b', old: null, new: 2 },
  ]);
  const before = JSON.stringify(ledger);
  assert.throws(
    () => rewrite(ledger, 2, { key: 'b', old: 9, new: 3 }),
    (err) => err.code === EXIT_CONFLICT && err.details.seq === 2,
  );
  assert.equal(JSON.stringify(ledger), before);
});

// ---------- sealed 与参数错误 ----------

test('sealed 提交不可改写，退出码语义为 2', () => {
  const ledger = createLedger();
  applyAll(ledger, [
    { key: 'a', old: null, new: 1 },
    { key: 'a', old: 1, new: 2 },
  ]);
  seal(ledger, 1);
  const before = JSON.stringify(ledger);
  assert.throws(
    () => rewrite(ledger, 1, { key: 'a', old: null, new: 9 }),
    (err) => err.code === EXIT_USAGE,
  );
  assert.equal(JSON.stringify(ledger), before);
  const ok = rewrite(ledger, 2, { key: 'a', old: 1, new: 8 });
  assert.deepEqual(stateOf(ok.ledger), { a: 8 }, '未 sealed 的提交仍可重写');
});

test('非法 seq / 非法补丁报参数错误码 2', () => {
  const ledger = createLedger();
  apply(ledger, { key: 'a', old: null, new: 1 });
  for (const bad of [0, 2, -1, 1.5, 'x', NaN]) {
    assert.throws(() => rewrite(ledger, bad, { key: 'a', old: 1, new: 2 }), (e) => e.code === EXIT_USAGE);
  }
  assert.throws(() => rewrite(ledger, 1, { key: 'a', old: 1 }), (e) => e.code === EXIT_USAGE);
  assert.throws(() => rewrite(ledger, 1, { old: null, new: 1 }), (e) => e.code === EXIT_USAGE);
  assert.throws(() => apply(ledger, { key: '', old: null, new: 1 }), (e) => e.code === EXIT_USAGE);
});

// ---------- 对照实验：<=5 个键枚举补丁序列与逆操作重放 ----------

test('枚举 <=5 键的补丁序列：undo/redo 与逆补丁重放对照', () => {
  const KEYS = ['k1', 'k2', 'k3', 'k4', 'k5'];
  const VALUES = [0, 1];
  const LEN = 4;

  // 逆操作重放：从最终状态出发，按逆序应用逆补丁，应回到初始状态。
  function replayInverse(records, finalState) {
    const state = structuredClone(finalState);
    for (let i = records.length - 1; i >= 0; i--) {
      const inv = records[i].inverse;
      const cur = Object.prototype.hasOwnProperty.call(state, inv.key) ? state[inv.key] : null;
      assert.equal(stableStringify(cur), stableStringify(inv.old), `逆补丁 ${i + 1} 守卫成立`);
      if (inv.new === null) delete state[inv.key]; else state[inv.key] = inv.new;
    }
    return state;
  }

  let checked = 0;
  function walk(state, depth, patches) {
    if (depth === LEN) {
      const ledger = createLedger();
      applyAll(ledger, patches);
      const finalState = stateOf(ledger);
      assert.deepEqual(finalState, state, '账本状态与模拟一致');
      assert.equal(ledger.records[ledger.records.length - 1].stateHash, stateHashOf(finalState));
      assert.equal(ledger.records[0].prevHash, GENESIS_HASH);

      assert.deepEqual(replayInverse(ledger.records, finalState), {}, '逆操作重放回到初始状态');

      for (let i = 0; i < LEN; i++) assert.equal(undo(ledger), true);
      assert.equal(ledger.cursor, 0);
      assert.deepEqual(stateOf(ledger), {}, '全部 undo 回到初始状态');
      for (let i = 0; i < LEN; i++) assert.equal(redo(ledger), true);
      assert.equal(ledger.cursor, LEN);
      assert.deepEqual(stateOf(ledger), finalState, '全部 redo 回到最终状态');
      checked++;
      return;
    }
    for (const key of KEYS) {
      const cur = Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
      for (const next of VALUES) {
        const patch = { key, old: cur, new: next };
        const nextState = structuredClone(state);
        nextState[key] = next;
        walk(nextState, depth + 1, [...patches, patch]);
      }
    }
  }
  walk({}, 0, []);
  assert.equal(checked, (KEYS.length * VALUES.length) ** LEN, '穷举序列数量正确');
});

// ---------- CLI ----------

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

// 沙箱环境禁止 spawn 子进程，因此在进程内调用 main() 驱动 CLI，
// 捕获 console.error 以校验错误输出。
function runCli(args) {
  let stderr = '';
  const origError = console.error;
  console.error = (...parts) => { stderr += parts.join(' ') + '\n'; };
  try {
    const status = main(['node', 'index.js', ...args]);
    return { status, stderr };
  } finally {
    console.error = origError;
  }
}

test('CLI rewrite 成功：退出码 0，输出新账本与哈希映射', () => {
  const dir = tmpdir();
  const ledger = createLedger();
  applyAll(ledger, [
    { key: 'a', old: null, new: 1 },
    { key: 'b', old: null, new: 5 },
    { key: 'c', old: null, new: 7 },
  ]);
  const book = path.join(dir, 'b.json');
  const patchFile = path.join(dir, 'p.json');
  const out = path.join(dir, 'n.json');
  fs.writeFileSync(book, JSON.stringify(ledger));
  fs.writeFileSync(patchFile, JSON.stringify({ key: 'b', old: null, new: 6 }));

  const res = runCli(['rewrite', '--book', book, '--seq', '2', '--patch', patchFile, '--out', out]);
  assert.equal(res.status, EXIT_OK, res.stderr);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.ledger.records[1].patch.new, 6);
  assert.deepEqual(stateOf(result.ledger), { a: 1, b: 6, c: 7 });
  assert.equal(Object.keys(result.hashMap).length, 2);
  assert.equal(result.hashMap[ledger.records[1].hash], result.ledger.records[1].hash);
  assert.deepEqual(JSON.parse(fs.readFileSync(book, 'utf8')), JSON.parse(JSON.stringify(ledger)), '原账本文件不变');
});

test('CLI rewrite 冲突：退出码 1，报告首个失败点，不写输出文件', () => {
  const dir = tmpdir();
  const ledger = createLedger();
  applyAll(ledger, [
    { key: 'a', old: null, new: 1 },
    { key: 'a', old: 1, new: 2 },
    { key: 'a', old: 2, new: 3 },
  ]);
  const book = path.join(dir, 'b.json');
  const patchFile = path.join(dir, 'p.json');
  const out = path.join(dir, 'n.json');
  fs.writeFileSync(book, JSON.stringify(ledger));
  fs.writeFileSync(patchFile, JSON.stringify({ key: 'a', old: 1, new: 9 }));

  const res = runCli(['rewrite', '--book', book, '--seq', '2', '--patch', patchFile, '--out', out]);
  assert.equal(res.status, EXIT_CONFLICT);
  assert.match(res.stderr, /commit 3/, '报告首个失败点');
  assert.equal(fs.existsSync(out), false, '失败不产生输出文件');
});

test('CLI sealed 改写与参数错误：退出码 2', () => {
  const dir = tmpdir();
  const ledger = createLedger();
  apply(ledger, { key: 'a', old: null, new: 1 });
  seal(ledger, 1);
  const book = path.join(dir, 'b.json');
  const patchFile = path.join(dir, 'p.json');
  const out = path.join(dir, 'n.json');
  fs.writeFileSync(book, JSON.stringify(ledger));
  fs.writeFileSync(patchFile, JSON.stringify({ key: 'a', old: null, new: 2 }));

  const sealed = runCli(['rewrite', '--book', book, '--seq', '1', '--patch', patchFile, '--out', out]);
  assert.equal(sealed.status, EXIT_USAGE);
  assert.equal(fs.existsSync(out), false);

  assert.equal(runCli(['rewrite', '--book', book, '--seq', '1', '--patch', patchFile]).status, EXIT_USAGE);
  assert.equal(runCli(['rewrite', '--book', book, '--seq', 'abc', '--patch', patchFile, '--out', out]).status, EXIT_USAGE);
  assert.equal(runCli(['rewrite', '--book', book, '--seq', '9', '--patch', patchFile, '--out', out]).status, EXIT_USAGE);
  assert.equal(runCli(['unknown', '--book', book]).status, EXIT_USAGE);
  assert.equal(runCli(['rewrite', '--book', path.join(dir, 'nope.json'), '--seq', '1', '--patch', patchFile, '--out', out]).status, EXIT_USAGE);
});
