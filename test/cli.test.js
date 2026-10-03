'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cli = require('../lib/cli');
const { tmpDir } = require('./helpers');

// In-process CLI harness: the sandbox forbids spawning child processes, and
// cli.run already returns the exact exit code the wrapper would use.
function run(dir, args, env = {}) {
  const stdout = [];
  const stderr = [];
  const code = cli.run(['--dir', dir, ...args], {
    out: (m) => stdout.push(m),
    err: (m) => stderr.push(m),
  }, { ...process.env, ...env });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function ok(res) {
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  return res.stdout;
}

test('cli: full flow begin/add/rewrite/commit/status', () => {
  const dir = tmpDir();
  ok(run(dir, ['begin', '2026-10-04']));
  ok(run(dir, ['add', '{"id":"e1","account":"A","amount":100}']));
  ok(run(dir, ['add', '{"id":"e2","account":"A","amount":-100}']));
  ok(run(dir, ['add', '{"id":"e3","account":"B","amount":40}']));
  const plan = path.join(dir, 'plan.json');
  fs.writeFileSync(
    plan,
    JSON.stringify({ date: '2026-10-04', dropIds: ['e1', 'e2'], fixAmounts: { e3: 45 } })
  );
  // unbalanced fixAmounts -> exit 22
  let res = run(dir, ['rewrite', plan]);
  assert.equal(res.code, 22, res.stderr);
  assert.match(res.stderr, /E_PLAN_INVALID/);
  fs.writeFileSync(plan, JSON.stringify({ date: '2026-10-04', dropIds: ['e1', 'e2'] }));
  ok(run(dir, ['rewrite', plan]));
  ok(run(dir, ['commit']));
  assert.match(ok(run(dir, ['status'])), /^STATUS=COMMITTED_NEW evidence=HEAD,snapshot\.json$/);
});

test('cli: cross-day rewrite exits 21', () => {
  const dir = tmpDir();
  ok(run(dir, ['begin', '2026-10-04']));
  const plan = path.join(dir, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ date: '2026-10-05', dropIds: [] }));
  const res = run(dir, ['rewrite', plan]);
  assert.equal(res.code, 21, res.stderr);
  assert.match(res.stderr, /E_CROSS_DAY/);
});

test('cli: fault injection then recover is deterministic for all three points', () => {
  // [recover result, steady-state status afterwards]
  const expected = {
    'before-fsync': ['OPEN_OLD', 'OPEN_OLD'],
    'before-wal-rename': ['OPEN_NEW', 'OPEN_OLD'], // staged snapshot adopted into wal
    'after-head-update': ['COMMITTED_NEW', 'COMMITTED_NEW'],
  };
  for (const [point, [want, after]] of Object.entries(expected)) {
    const dir = tmpDir();
    ok(run(dir, ['begin', '2026-10-04']));
    ok(run(dir, ['add', '{"id":"e1","account":"A","amount":100}']));
    ok(run(dir, ['add', '{"id":"e2","account":"A","amount":-100}']));
    const crash = run(dir, ['--crash-at', point, 'commit']);
    assert.equal(crash.code, 75, `${point}: ${crash.stderr}`);
    assert.match(crash.stderr, new RegExp(`CRASH at=${point}`));
    const rec = run(dir, ['recover']);
    assert.equal(rec.code, 0, `${point}: ${rec.stderr}`);
    assert.match(rec.stdout, new RegExp(`^STATUS=${want} evidence=`), `${point}: ${rec.stdout}`);
    // status after recover agrees
    assert.match(ok(run(dir, ['status'])), new RegExp(`^STATUS=${after}`));
  }
});

test('cli: recovery ambiguity exits 23', () => {
  const dir = tmpDir();
  ok(run(dir, ['begin', '2026-10-04']));
  ok(run(dir, ['add', '{"id":"e1","account":"A","amount":100}']));
  fs.renameSync(path.join(dir, 'wal.jsonl'), path.join(dir, 'wal.jsonl.archived'));
  const res = run(dir, ['recover']);
  assert.equal(res.code, 23, res.stderr);
  assert.match(res.stderr, /E_RECOVER_AMBIGUOUS/);
});

test('cli: reversal causality violation rejected with exit 22', () => {
  const dir = tmpDir();
  ok(run(dir, ['begin', '2026-10-04']));
  ok(run(dir, ['add', '{"id":"o","account":"A","amount":100}']));
  ok(run(dir, ['add', '{"id":"r","account":"A","amount":-100,"type":"REVERSAL","refId":"o"}']));
  const plan = path.join(dir, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ date: '2026-10-04', moveBefore: { r: 'o' } }));
  const res = run(dir, ['rewrite', plan]);
  assert.equal(res.code, 22, res.stderr);
  assert.match(res.stderr, /E_PLAN_INVALID/);
});
