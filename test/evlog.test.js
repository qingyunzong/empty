'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const evlog = require('../lib/evlog');
const cli = require('../cli.js');

const { encodeBlock, checkpointPath } = evlog._internals;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-test-'));
}

function buildLog(dir, payloads) {
  const log = path.join(dir, 'log.evlog');
  const h = evlog.open(log);
  for (const p of payloads) {
    evlog.append(h, p);
    evlog.commit(h);
  }
  return log;
}

/* ---------- 验收 1: 三类崩溃点注入后恢复确定 ---------- */
test('crash point A: append without commit is dropped by recover', () => {
  const dir = tmpdir();
  const log = buildLog(dir, ['e1', 'e2']);
  const h = evlog.open(log);
  evlog.append(h, 'e3-uncommitted'); // 崩溃点：append 后、commit 前被杀
  const r1 = evlog.recover(log);
  assert.equal(r1.lastSeq, 2);
  assert.equal(r1.dropped, 1);
  assert.deepEqual(evlog.tail(log, 10).map((e) => e.payload), ['e1', 'e2']);
  const r2 = evlog.recover(log); // 确定性：再次 recover 结果一致
  assert.deepEqual(r2, { ...r1, dropped: 0, truncatedBytes: 0 });
  assert.equal(r2.lastSeq, 2);
});

test('crash point B: half-written commit block recovers to last complete commit', () => {
  const dir = tmpdir();
  const log = buildLog(dir, ['e1']);
  const h = evlog.open(log);
  evlog.append(h, 'e2');
  // 崩溃点：commit 块写到一半（有效内容、物理截断）
  const st = evlog._internals.scanLog(log);
  const half = encodeBlock({ t: 'c', seq: 2, root: st.pending[0].hash }).subarray(0, 11);
  fs.appendFileSync(log, half);
  const r = evlog.recover(log);
  assert.equal(r.lastSeq, 1);
  assert.equal(r.dropped, 1);
  assert.ok(r.truncatedBytes > 0);
  assert.deepEqual(evlog.tail(log, 10).map((e) => e.payload), ['e1']);
  assert.equal(evlog.verify(log).ok, true);
  const sizeAfter = fs.statSync(log).size;
  evlog.recover(log); // 幂等
  assert.equal(fs.statSync(log).size, sizeAfter);
});

test('crash point C: stale checkpoint is rebuilt from the log', () => {
  const dir = tmpdir();
  const log = buildLog(dir, ['e1', 'e2', 'e3']);
  // 崩溃点：commit 落盘但检查点未更新（回退到旧值）
  fs.writeFileSync(checkpointPath(log), JSON.stringify({ lastSeq: 1, root: 'deadbeef' }) + '\n');
  const r1 = evlog.recover(log);
  assert.equal(r1.lastSeq, 3);
  const ck = JSON.parse(fs.readFileSync(checkpointPath(log), 'utf8'));
  assert.equal(ck.lastSeq, 3);
  assert.equal(ck.root, r1.root);
  const r2 = evlog.recover(log); // 确定性
  assert.deepEqual(r2, r1);
});

/* ---------- 验收 2: 小日志枚举全部前缀验证 tail ---------- */
test('tail enumerates every prefix of a small committed log', () => {
  const dir = tmpdir();
  const N = 6;
  const entries = Array.from({ length: N }, (_, i) => `entry-${i + 1}`);
  const log = buildLog(dir, entries);
  for (let k = 0; k <= N; k++) {
    const t = evlog.tail(log, k);
    assert.equal(t.length, k);
    assert.deepEqual(t.map((e) => e.payload), entries.slice(N - k));
    assert.deepEqual(t.map((e) => e.seq), Array.from({ length: k }, (_, i) => N - k + i + 1));
  }
  assert.equal(evlog.tail(log, N + 10).length, N); // 超出长度返回全部
  const h = evlog.open(log);
  evlog.append(h, 'uncommitted'); // tail 只返回已提交
  assert.equal(evlog.tail(log, N + 10).length, N);
});

/* ---------- 验收 3: 旧根续写拒绝 (ERR_STALE_ROOT) ---------- */
test('second committer on a stale root is rejected with ERR_STALE_ROOT', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'log.evlog');
  const a = evlog.open(log);
  const b = evlog.open(log); // 两个句柄写同一文件
  evlog.append(a, 'A1');
  evlog.commit(a);
  evlog.append(b, 'B1'); // B 基于旧根
  assert.throws(() => evlog.commit(b), (e) => e.code === 'ERR_STALE_ROOT');
  const r = evlog.recover(log); // B 的未提交块被丢弃
  assert.equal(r.lastSeq, 1);
  assert.deepEqual(evlog.tail(log, 10).map((e) => e.payload), ['A1']);
  assert.equal(evlog.verify(log).ok, true);
});

/* ---------- 验收 4: 检查点损坏从日志重建 ---------- */
test('corrupt checkpoint is rebuilt from the log', () => {
  const dir = tmpdir();
  const log = buildLog(dir, ['x1', 'x2', 'x3']);
  fs.writeFileSync(checkpointPath(log), '}{ not json at all');
  const r = evlog.recover(log);
  assert.equal(r.lastSeq, 3);
  const ck = JSON.parse(fs.readFileSync(checkpointPath(log), 'utf8'));
  assert.deepEqual(ck, { lastSeq: r.lastSeq, root: r.root });
  assert.equal(evlog.verify(log).ok, true);
});

/* ---------- 验收 5: 空日志 recover 幂等 ---------- */
test('recover on empty/missing log is idempotent', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'empty.evlog');
  const r1 = evlog.recover(log);
  assert.equal(r1.lastSeq, 0);
  assert.equal(r1.root, evlog.GENESIS);
  const r2 = evlog.recover(log);
  assert.deepEqual(r2, r1);
  assert.ok(fs.existsSync(log));
  assert.ok(fs.existsSync(checkpointPath(log)));
  assert.deepEqual(evlog.tail(log, 5), []);
  assert.equal(evlog.verify(log).ok, true);
});

/* ---------- 错误码: ERR_CRC / ERR_FORK / ERR_SEQ ---------- */
test('verify detects tampering with ERR_CRC', () => {
  const dir = tmpdir();
  const log = buildLog(dir, ['a', 'b', 'c']);
  const buf = fs.readFileSync(log);
  buf[20] ^= 0xff; // 翻转已提交区域一个字节
  fs.writeFileSync(log, buf);
  assert.throws(() => evlog.verify(log), (e) => e.code === 'ERR_CRC');
});

test('verify rejects forged continuation with ERR_FORK', () => {
  const dir = tmpdir();
  const log = buildLog(dir, ['a']);
  // 伪造续写：prevHash 不链接
  fs.appendFileSync(log, encodeBlock({ t: 'd', seq: 2, prevHash: 'f'.repeat(64), payload: 'forged' }));
  assert.throws(() => evlog.verify(log), (e) => e.code === 'ERR_FORK');
});

test('verify rejects sequence regression with ERR_FORK', () => {
  const dir = tmpdir();
  const log = buildLog(dir, ['a', 'b']);
  const st = evlog._internals.scanLog(log);
  fs.appendFileSync(log, encodeBlock({ t: 'd', seq: 1, prevHash: st.root, payload: 'replay' }));
  assert.throws(() => evlog.verify(log), (e) => e.code === 'ERR_FORK');
});

test('verify rejects sequence gap with ERR_SEQ', () => {
  const dir = tmpdir();
  const log = buildLog(dir, ['a']);
  const st = evlog._internals.scanLog(log);
  fs.appendFileSync(log, encodeBlock({ t: 'd', seq: 5, prevHash: st.root, payload: 'skip' }));
  assert.throws(() => evlog.verify(log), (e) => e.code === 'ERR_SEQ');
});

/* ---------- CLI 测试(进程内调用 cli.run,捕获 stdout/stderr) ---------- */
function runCli(...args) {
  let stdout = '';
  let stderr = '';
  const code = cli.run(['node', 'cli.js', ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { code, stdout, stderr };
}

test('cli: append/commit/tail/recover round-trip and JSON error on stderr', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'cli.evlog');
  assert.equal(runCli('append', log, 'hello').code, 0);
  assert.equal(runCli('commit', log).code, 0);
  const tailOut = JSON.parse(runCli('tail', log, '5').stdout);
  assert.deepEqual(tailOut.entries.map((e) => e.payload), ['hello']);
  const recOut = JSON.parse(runCli('recover', log).stdout);
  assert.equal(recOut.ok, true);
  assert.equal(recOut.lastSeq, 1);
  // 篡改后 verify 应以非零退出并在 stderr 输出 JSON 错误
  const buf = fs.readFileSync(log);
  buf[20] ^= 0xff;
  fs.writeFileSync(log, buf);
  const bad = runCli('verify', log);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stderr).error, 'ERR_CRC');
});

test('multiple appends across handles chain and commit together', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'multi.evlog');
  // 模拟 CLI 多次调用:每次 append 都是新句柄
  assert.equal(evlog.append(evlog.open(log), 'm1'), 1);
  assert.equal(evlog.append(evlog.open(log), 'm2'), 2);
  assert.equal(evlog.append(evlog.open(log), 'm3'), 3);
  const r = evlog.commit(evlog.open(log));
  assert.equal(r.lastSeq, 3);
  assert.equal(r.committed, 3);
  assert.deepEqual(evlog.tail(log, 10).map((e) => e.payload), ['m1', 'm2', 'm3']);
  assert.equal(evlog.verify(log).ok, true);
});
