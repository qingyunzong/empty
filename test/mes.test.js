'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, parseJsonl, ValidationError } = require('../lib');

const CLI = path.join(__dirname, '..', 'cli.js');

function ev(seq, over = {}) {
  return {
    lot: 'L', mold: 'M', station: 'S', seq,
    ts: seq * 100, kind: 'produce', qty: 1, hash: `h${seq}`,
    ...over,
  };
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function withTempFile(content, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mes-')), 'events.jsonl');
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

// 验收 1:乱序 + 重复到达后,canonical 链与排序参考一致。
test('1: out-of-order + duplicates match sorted reference', () => {
  const base = [ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)];
  const reference = new Store({ now: 10000 });
  for (const e of base) reference.ingest(e);
  const refReport = reference.finalize();

  const shuffled = [base[3], base[0], base[5], base[2], base[1], base[4]];
  const withDups = [...shuffled, base[2], base[0], base[5]]; // 3 个重复
  const store = new Store({ now: 10000 });
  for (const e of withDups) store.ingest(e);
  const report = store.finalize();

  assert.equal(report.stats.duplicates, 3);
  assert.equal(report.stats.stored, 6);
  assert.deepEqual(report.chains, refReport.chains);
  assert.deepEqual(report.chains[0].events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
});

// 验收 2:迟到更正替换 future=false 事件,旧证书被 revoke,新证书哈希变化。
test('2: late correction revokes old certificate and changes digest', () => {
  const store = new Store({ now: 10000 });
  store.ingest(ev(1, { ts: 100, kind: 'produce', qty: 10, hash: 'A1' }));
  store.ingest(ev(2, { ts: 200, kind: 'seal', qty: 0, hash: 'B1' }));

  let report = store.finalize();
  assert.equal(report.certificates.length, 1);
  assert.equal(report.revocations.length, 0);
  const v1 = report.certificates[0];

  // 迟到更正:同 key 不同 hash/qty,被替换事件 ts=100 <= now(future=false)
  const res = store.ingest(ev(1, { ts: 100, kind: 'produce', qty: 20, hash: 'A2' }));
  assert.deepEqual(res, { applied: true, correction: true });

  report = store.finalize();
  assert.equal(report.certificates.length, 2);
  assert.equal(report.revocations.length, 1);
  const v2 = report.certificates[1];
  assert.equal(v2.version, 2);
  assert.notEqual(v1.digest, v2.digest);
  assert.deepEqual(report.revocations[0], {
    lot: 'L', version: 1, digest: v1.digest,
    reason: 'superseded-by-correction', at: 10000,
  });
  // 已导出证书条目不可变:日志中 v1 条目保持原样
  assert.deepEqual(report.certificates[0], v1);
  // 链内容已更新
  assert.equal(report.chains[0].events[0].qty, 20);
  assert.equal(report.chains[0].finalBalance, 20);
});

// future=true(ts > now)事件不可被更正。
test('2b: correction of future event is rejected', () => {
  const store = new Store({ now: 50 });
  store.ingest(ev(1, { ts: 100, hash: 'A1' }));
  const res = store.ingest(ev(1, { ts: 100, hash: 'A2' }));
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'future-event-immutable');
  const report = store.finalize();
  assert.equal(report.stats.rejected, 1);
  assert.equal(report.chains[0].events[0].hash, 'A1');
});

// 验收 3:deadline 边界,age == deadline 恰好超时记 gap,age == deadline-1 仍为 NAK。
test('3: deadline boundary event expires exactly at deadline', () => {
  // 流内 seq 2 缺失,seq 3 (ts=4000) 为后继参考点
  const make = (now) => {
    const store = new Store({ now, deadline: 1000 });
    store.ingest(ev(1, { ts: 0 }));
    store.ingest(ev(3, { ts: 4000 }));
    return store.finalize();
  };
  const atBoundary = make(5000); // age = 5000-4000 = 1000 == deadline
  assert.equal(atBoundary.gaps.length, 1);
  assert.equal(atBoundary.naks.length, 0);
  assert.deepEqual(
    (({ seq, refTs, age, deadline }) => ({ seq, refTs, age, deadline }))(atBoundary.gaps[0]),
    { seq: 2, refTs: 4000, age: 1000, deadline: 1000 },
  );
  const beforeBoundary = make(4999); // age = 999 < deadline
  assert.equal(beforeBoundary.gaps.length, 0);
  assert.equal(beforeBoundary.naks.length, 1);
  assert.equal(beforeBoundary.naks[0].seq, 2);
});

// 验收 4:枚举 1..8 全排列(40320 种,各含重复事件),去重排序结果全部一致。
test('4: all 40320 permutations of seq 1..8 dedupe to identical chain', () => {
  function* permutations(arr) {
    if (arr.length <= 1) { yield arr.slice(); return; }
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permutations(rest)) yield [arr[i], ...p];
    }
  }
  const seqs = [1, 2, 3, 4, 5, 6, 7, 8];
  let count = 0;
  let reference = null;
  for (const perm of permutations(seqs)) {
    const store = new Store({ now: 10000 });
    for (const seq of perm) {
      const e = ev(seq);
      store.ingest(e);
      store.ingest(e); // 每个事件重复到达一次
    }
    const report = store.finalize();
    assert.equal(report.stats.duplicates, 8);
    assert.equal(report.stats.stored, 8);
    assert.deepEqual(report.chains[0].events.map((e) => e.seq), seqs);
    const json = JSON.stringify(report.chains);
    if (reference === null) reference = json;
    assert.equal(json, reference);
    count++;
  }
  assert.equal(count, 40320);
});

// 守恒:produce -> split/consume 前缀余额不得为负。
test('conservation: negative prefix balance throws and CLI exits 4', () => {
  const store = new Store({ now: 10000 });
  store.ingest(ev(1, { kind: 'produce', qty: 3 }));
  store.ingest(ev(2, { kind: 'split', qty: 2 }));
  store.ingest(ev(3, { kind: 'consume', qty: 2 })); // 3-2-2 = -1 破坏守恒
  assert.throws(() => store.finalize(), /negative balance/);

  const input = [
    ev(1, { kind: 'produce', qty: 3 }),
    ev(2, { kind: 'consume', qty: 5 }),
  ].map((e) => JSON.stringify(e)).join('\n');
  withTempFile(input, (file) => {
    const res = runCli([file, '--now', '5000']);
    assert.equal(res.status, 4);
    assert.match(res.stderr, /conservation violation/);
  });
});

// 守恒通过:split/merge 守恒的正常链。
test('conservation: balanced split/merge chain passes', () => {
  const store = new Store({ now: 10000 });
  store.ingest(ev(1, { kind: 'produce', qty: 10 }));
  store.ingest(ev(2, { kind: 'split', qty: 4 }));
  store.ingest(ev(3, { kind: 'merge', qty: 4 }));
  store.ingest(ev(4, { kind: 'consume', qty: 10 }));
  const report = store.finalize();
  assert.equal(report.chains[0].finalBalance, 0);
  assert.deepEqual(report.chains[0].events.map((e) => e.balance), [10, 6, 10, 0]);
});

// 输入非法 -> exit 2。
test('invalid input exits 2', () => {
  withTempFile('{"lot":"L", broken\n', (file) => {
    const res = runCli([file]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /line 1/);
  });
  withTempFile(JSON.stringify({ lot: 'L' }) + '\n', (file) => {
    const res = runCli([file]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /missing field/);
  });
  withTempFile(JSON.stringify(ev(1, { qty: -1 })) + '\n', (file) => {
    assert.equal(runCli([file]).status, 2);
  });
  withTempFile(JSON.stringify(ev(1, { kind: 'bogus' })) + '\n', (file) => {
    assert.equal(runCli([file]).status, 2);
  });
  withTempFile(JSON.stringify(ev(1, { extra: 1 })) + '\n', (file) => {
    assert.equal(runCli([file]).status, 2);
  });
  assert.equal(runCli([]).status, 2); // 缺文件参数
  assert.equal(runCli(['/nonexistent.jsonl']).status, 2); // 文件不可读
  withTempFile('', (file) => {
    assert.equal(runCli([file, '--now', 'abc']).status, 2); // 非法 --now
  });
  assert.throws(() => parseJsonl('not json'), ValidationError);
});

// CLI 正常路径:exit 0 且输出 canonical 链 / gap 表 / 证书。
test('cli happy path exits 0 with canonical chain, gaps, certificates', () => {
  const lines = [
    ev(2, { lot: 'L1', ts: 200, kind: 'produce', qty: 5, hash: 'b' }),
    ev(1, { lot: 'L1', ts: 100, kind: 'produce', qty: 5, hash: 'a' }),
    ev(4, { lot: 'L1', ts: 4000, kind: 'consume', qty: 3, hash: 'd' }),
    ev(5, { lot: 'L1', ts: 4500, kind: 'seal', qty: 0, hash: 'e' }),
    ev(2, { lot: 'L1', ts: 200, kind: 'produce', qty: 5, hash: 'b' }), // 重复
  ].map((e) => JSON.stringify(e)).join('\n');
  withTempFile(lines, (file) => {
    const res = runCli([file, '--now', '5000']);
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.deepEqual(report.chains[0].events.map((e) => e.seq), [1, 2, 4, 5]);
    assert.equal(report.gaps.length, 1); // seq 3, age 1000 >= deadline 1000
    assert.equal(report.gaps[0].seq, 3);
    assert.equal(report.certificates.length, 1); // gap 不阻塞证书导出
    assert.equal(report.stats.duplicates, 1);
  });
});
