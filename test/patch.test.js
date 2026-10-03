'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EXIT,
  PatchError,
  hashState,
  available,
  makePatch,
  applyPatch,
  revertPatch,
  canonical,
} = require('../patchlib');
const { run } = require('../cli');
const crypto = require('node:crypto');


function baseState() {
  return {
    accounts: {
      a1: { limit: 1000, used: 200, holds: [{ hid: 'h1', amount: 100, tag: 'fraud' }] },
      a2: { limit: 500, used: 0, holds: [] },
    },
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'risk-patch-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// 进程内执行 CLI，捕获输出与退出码（离线环境不 fork 子进程）
function runCli(args) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let status;
  try {
    status = run(args);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

// 测试辅助：修改补丁后重新签名（模拟“格式合法但业务非法”的补丁）
function resign(patch) {
  const body = Object.assign({}, patch);
  delete body.sha256;
  patch.sha256 = crypto.createHash('sha256').update(canonical(body)).digest('hex');
  return patch;
}

test('diff/apply: 新增与释放冻结', () => {
  const base = baseState();
  const target = baseState();
  target.accounts.a1.holds = []; // 释放 h1
  target.accounts.a2.holds = [{ hid: 'h9', amount: 50, tag: 'audit' }]; // 新增冻结
  target.accounts.a2.limit = 600;

  const patch = makePatch(base, target);
  const kinds = patch.ops.map((o) => o.op);
  assert.deepEqual(kinds, ['removeHold', 'setLimit', 'addHold']);

  const res = applyPatch(base, patch);
  assert.deepEqual(res.state, target);
  assert.equal(hashState(res.state), patch.toHash);
  assert.equal(available(res.state.accounts.a2), 550);
});

test('diff: changeTag 与 amount 变化（removeHold+addHold）', () => {
  const base = baseState();
  const target = baseState();
  target.accounts.a1.holds = [
    { hid: 'h1', amount: 100, tag: 'review' }, // tag 变化
    { hid: 'h2', amount: 30, tag: 'x' },
  ];
  const patch = makePatch(base, target);
  assert.ok(patch.ops.some((o) => o.op === 'changeTag' && o.hid === 'h1' && o.prevTag === 'fraud'));
  assert.deepEqual(applyPatch(base, patch).state, target);
});

test('apply: 超限原子失败，报告首个失败 opIndex，原状态不变', () => {
  const base = baseState();
  const patch = makePatch(base, (() => {
    const t = baseState();
    t.accounts.a2.holds = [{ hid: 'h9', amount: 50, tag: 'ok' }];
    return t;
  })());
  // 追加一个必然超限的 op（可用额 500，冻结 999）
  const evil = JSON.parse(JSON.stringify(patch));
  evil.ops.push({ op: 'addHold', account: 'a2', hold: { hid: 'h10', amount: 999, tag: 'bad' } });
  resign(evil); // 重新签名以通过完整性校验，专注验证额度校验

  const before = JSON.stringify(base);
  let err = null;
  try {
    applyPatch(base, evil);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof PatchError);
  assert.equal(err.exitCode, EXIT.INSUFFICIENT_LIMIT);
  assert.equal(err.opIndex, 1); // 首个失败 op 的下标
  assert.equal(JSON.stringify(base), before); // 原子：原状态未被污染
});

test('apply: 幂等，重复应用为 no-op', () => {
  const base = baseState();
  const target = baseState();
  target.accounts.a2.limit = 800;
  const patch = makePatch(base, target);
  const once = applyPatch(base, patch);
  const twice = applyPatch(once.state, patch);
  assert.equal(twice.alreadyApplied, true);
  assert.equal(twice.appliedOps, 0);
  assert.deepEqual(twice.state, once.state);
});

test('revert: 回到基态；哈希不符时拒绝', () => {
  const base = baseState();
  const target = baseState();
  target.accounts.a1.limit = 700;
  target.accounts.a1.holds.push({ hid: 'h2', amount: 50, tag: 'new' });
  const patch = makePatch(base, target);
  const applied = applyPatch(base, patch);
  const reverted = revertPatch(applied.state, patch);
  assert.deepEqual(reverted.state, base);
  assert.equal(hashState(reverted.state), patch.fromHash);

  // 当前哈希 != toHash（例如已回滚过的基态）→ 拒绝
  assert.throws(() => revertPatch(base, patch), (e) => {
    assert.equal(e.exitCode, EXIT.HASH_MISMATCH);
    return true;
  });
});

test('apply: 未知 op exit8，哈希不匹配 exit6', () => {
  const base = baseState();
  const target = baseState();
  target.accounts.a2.limit = 900;
  const patch = makePatch(base, target);

  const badOp = JSON.parse(JSON.stringify(patch));
  badOp.ops = [{ op: 'wipeAll' }];
  assert.throws(() => applyPatch(base, badOp), (e) => e.exitCode === EXIT.HASH_MISMATCH); // 签名先坏

  // 篡改状态导致 fromHash 不匹配
  const drifted = baseState();
  drifted.accounts.a2.used = 1;
  assert.throws(() => applyPatch(drifted, patch), (e) => e.exitCode === EXIT.HASH_MISMATCH);
});

test('CLI: 端到端 diff/apply/revert 与退出码', () => {
  const dir = tmpdir();
  const baseFile = path.join(dir, 'base.json');
  const targetFile = path.join(dir, 'target.json');
  const stateFile = path.join(dir, 'state.json');
  const patchFile = path.join(dir, 'patch.json');

  const base = baseState();
  const target = baseState();
  target.accounts.a1.holds.push({ hid: 'h2', amount: 40, tag: 'audit' });
  target.accounts.a2.limit = 450;
  writeJson(baseFile, base);
  writeJson(targetFile, target);
  writeJson(stateFile, base);

  let r = runCli(['diff', baseFile, targetFile, '--out', patchFile]);
  assert.equal(r.status, 0, r.stderr);

  r = runCli(['apply', stateFile, patchFile, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), base); // dry-run 不落盘

  r = runCli(['apply', stateFile, patchFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), target);

  r = runCli(['apply', stateFile, patchFile]); // 重复 apply 幂等
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already applied/);

  r = runCli(['revert', stateFile, patchFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), base);

  r = runCli(['revert', stateFile, patchFile]); // 错误 revert：当前哈希 != toHash
  assert.equal(r.status, EXIT.HASH_MISMATCH, r.stderr);
});

test('CLI: 超限 apply 原子失败 exit7 且文件不变', () => {
  const dir = tmpdir();
  const stateFile = path.join(dir, 'state.json');
  const patchFile = path.join(dir, 'patch.json');
  const base = baseState();
  writeJson(stateFile, base);
  // 手工构造超限补丁：a2 可用 500，冻结 999
  const patch = makePatch(base, (() => {
    const t = baseState();
    t.accounts.a2.holds = [{ hid: 'h9', amount: 10, tag: 'ok' }];
    return t;
  })());
  patch.ops.push({ op: 'addHold', account: 'a2', hold: { hid: 'h10', amount: 999, tag: 'bad' } });
  resign(patch);
  writeJson(patchFile, patch);

  const r = runCli(['apply', stateFile, patchFile]);
  assert.equal(r.status, EXIT.INSUFFICIENT_LIMIT, r.stderr);
  assert.match(r.stderr, /opIndex=1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), base); // 原子回滚
});

test('CLI: 未知 op exit8', () => {
  const dir = tmpdir();
  const stateFile = path.join(dir, 'state.json');
  const patchFile = path.join(dir, 'patch.json');
  const base = baseState();
  writeJson(stateFile, base);
  const drifted = baseState();
  drifted.accounts.a2.limit = 900; // 让 toHash != 当前状态，避免幂等短路
  const patch = makePatch(base, drifted);
  patch.ops = [{ op: 'wipeAll', account: 'a1' }];
  resign(patch);
  writeJson(patchFile, patch);

  const r = runCli(['apply', stateFile, patchFile]);
  assert.equal(r.status, EXIT.UNKNOWN_OP, r.stderr);
  assert.match(r.stderr, /opIndex=0/);
});
