'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, EXIT } = require('../cli');

function setup(lines, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  const ops = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(ops, lines.join('\n') + '\n');
  const argv = ['node', 'cli.js', ops, '--wal', path.join(dir, 'wal.bin')];
  if (config) {
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(config));
    argv.push('--config', cfg);
  }
  return argv;
}

function run(argv) {
  const out = [];
  const err = [];
  const status = main(argv, { log: (s) => out.push(s), error: (s) => err.push(s) });
  return { status, stdout: out, stderr: err };
}

const CONFIG = { budgetLimit: 50, slaMs: 100, highRiskTags: ['high'] };

test('end-to-end: acks, snapshot with per-key state, budget, audit hash', () => {
  const res = run(setup([
    '{"seq":0,"t":0,"op":{"op":"refund","key":"k1","order":"o1","amount":40,"riskTag":"high","paid":100}}',
    '{"seq":1,"t":10,"op":{"op":"approve","key":"k1"}}',
    '{"seq":2,"t":20,"op":{"op":"reverse","key":"k1"}}',
  ], CONFIG));
  assert.equal(res.status, EXIT.OK);
  const lines = res.stdout.map(JSON.parse);
  assert.equal(lines[0].ack, 0);
  assert.equal(lines[1].result.state, 'APPROVED');
  assert.equal(lines[2].result.state, 'REVERSED');
  const snap = lines[3].snapshot;
  assert.equal(snap.refunds.k1.state, 'REVERSED');
  assert.equal(snap.budget.used, 0, 'reverse released the budget');
  assert.equal(snap.orders.o1.remaining, 100, 'reverse restored the balance');
  assert.match(snap.auditHash, /^[0-9a-f]{64}$/);
});

test('restart replays the WAL: identical snapshot, no double deduction', () => {
  const argv = setup([
    '{"seq":0,"t":0,"op":{"op":"refund","key":"k1","order":"o1","amount":40,"riskTag":"high","paid":100}}',
    '{"seq":1,"t":10,"op":{"op":"approve","key":"k1"}}',
  ], CONFIG);
  const first = run(argv);
  assert.equal(first.status, EXIT.OK);
  const second = run(argv); // "restart": same WAL, same input
  assert.equal(second.status, EXIT.OK);
  const snap1 = JSON.parse(first.stdout[first.stdout.length - 1]).snapshot;
  const snap2 = JSON.parse(second.stdout[second.stdout.length - 1]).snapshot;
  assert.deepEqual(snap2, snap1);
  assert.equal(snap2.orders.o1.refunded, 40, 'deducted exactly once across restart');
  assert.equal(snap2.budget.used, 40);
  const acks = second.stdout.slice(0, -1).map(JSON.parse);
  assert.ok(acks.every((a) => a.dup === true), 'replayed frames re-served as duplicates');
});

test('exit 2 on frame error', () => {
  const res = run(setup([
    '{"seq":0,"t":0,"op":{"op":"refund","key":"k1","order":"o1","amount":10,"riskTag":"low","paid":100}}',
    '{broken json',
  ], CONFIG));
  assert.equal(res.status, EXIT.FRAME);
  assert.match(res.stderr[0], /frame error at line 2/);
});

test('exit 3 on key conflict', () => {
  const res = run(setup([
    '{"seq":0,"t":0,"op":{"op":"refund","key":"k1","order":"o1","amount":10,"riskTag":"low","paid":100}}',
    '{"seq":1,"t":1,"op":{"op":"refund","key":"k1","order":"o1","amount":20,"riskTag":"low","paid":100}}',
  ], CONFIG));
  assert.equal(res.status, EXIT.CONFLICT);
  const conflict = res.stdout.map(JSON.parse).find((l) => l.result && l.result.status === 'conflict');
  assert.equal(conflict.result.code, 'CONFLICT');
  assert.equal(conflict.result.originalAmount, 10);
});

test('exit 4 on limit exceeded', () => {
  const res = run(setup([
    '{"seq":0,"t":0,"op":{"op":"refund","key":"k1","order":"o1","amount":500,"riskTag":"low","paid":100}}',
  ], CONFIG));
  assert.equal(res.status, EXIT.LIMIT);
  const ack = JSON.parse(res.stdout[0]);
  assert.equal(ack.result.code, 'LIMIT_EXCEEDED');
});

test('out-of-order and retransmitted frames through the CLI', () => {
  const res = run(setup([
    '{"seq":1,"t":10,"op":{"op":"approve","key":"k1"}}',
    '{"seq":0,"t":0,"op":{"op":"refund","key":"k1","order":"o1","amount":40,"riskTag":"high","paid":100}}',
    '{"seq":1,"t":10,"op":{"op":"approve","key":"k1"}}',
  ], CONFIG));
  assert.equal(res.status, EXIT.OK);
  const acks = res.stdout.slice(0, -1).map(JSON.parse);
  assert.deepEqual(acks.map((a) => a.ack), [0, 1, 1]);
  assert.equal(acks[0].result.state, 'PENDING');
  assert.equal(acks[1].result.state, 'APPROVED');
  assert.equal(acks[2].dup, true);
});
