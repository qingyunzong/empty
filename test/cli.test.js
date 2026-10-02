'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../cli');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cli-'));
  const write = (name, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  };
  const channel = write('channel.csv',
    'recordId,batchId,parentId,customerId,amount,currency,timestamp,status\n' +
    'CH1,BCH1,,C1,100.00,CNY,2026-10-03T10:00:00Z,\n' +
    'CH2,BCH1,,C1,60.00,CNY,2026-10-03T10:01:00Z,\n' +
    'CH3,BCH1,,C1,40.00,CNY,2026-10-03T10:01:30Z,\n');
  const clearing = write('clearing.csv',
    'recordId,batchId,parentId,customerId,amount,currency,timestamp,status\n' +
    'CL1,BCL1,BCH1,C1,100.00,CNY,2026-10-03T10:02:00Z,\n' +
    'CL2,BCL1,BCH1,C1,100.00,CNY,2026-10-03T10:02:30Z,\n');
  const bank = write('bank.csv',
    'recordId,batchId,parentId,customerId,amount,currency,timestamp,status\n' +
    'BK1,BBK1,BCL1,C1,200.00,CNY,2026-10-03T10:03:00Z,confirmed\n' +
    'BK2,BBK2,BCL1,C1,200.00,CNY,2026-10-03T10:03:30Z,pending\n');
  const state = path.join(dir, 'state.json');
  return { dir, channel, clearing, bank, state };
}

// In-process CLI runner (the sandbox forbids spawning child processes).
const run = (args) => {
  const io = { stdout: '', stderr: '' };
  const status = runCli(args, {
    stdout: (s) => { io.stdout += s; },
    stderr: (s) => { io.stderr += s; },
  });
  return { status, ...io };
};

test('cli reconcile: matched pairs and one-to-many, orphans listed', () => {
  const { channel, clearing, bank } = setup();
  const res = run(['reconcile', '--channel', channel, '--clearing', clearing, '--bank', bank]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  // CL1 exact-matches CH1; CL2 = CH2+CH3 (one-to-many); BK1/BK2 both tie on CL1+CL2
  const cl2 = out.matched.find((m) => m.target === 'CL2');
  assert.deepEqual(cl2.chosen, ['CH2', 'CH3']);
  const bk1 = out.matched.find((m) => m.target === 'BK1');
  assert.deepEqual(bk1.chosen, ['CL1', 'CL2']);
  // BK2 loses the tie (CL records already used) and becomes an orphan
  assert.equal(out.unmatched.orphans.length, 1);
  assert.equal(out.unmatched.orphans[0].recordId, 'BK2');
  assert.equal(out.unmatched.orphans[0].code, 21);
});

test('cli load + rollback + budget roundtrip; confirmed bank reversed not rolled back', () => {
  const { channel, clearing, bank, state } = setup();
  let res = run(['load', '--channel', channel, '--clearing', clearing, '--bank', bank, '--state', state]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).total, 4);

  res = run(['budget', '--customer', 'C1', '--date', '2026-10-03', '--limit', '1000.00', '--state', state]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).limit, 100000);

  // rollback the root channel batch: closure = BCH1 -> BCL1 -> BBK1/BBK2
  res = run(['rollback', '--batch', 'BCH1', '--state', state]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(new Set(out.rolledBack), new Set(['BCH1', 'BCL1', 'BBK2']));
  assert.deepEqual(out.reversals, ['ADJ-BBK1']); // confirmed bank -> reversal only

  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.equal(saved.batches.find((b) => b.batchId === 'BBK1').status, 'active');
  // BCH1(200.00) + BCL1(200.00) + BBK1(200.00) + BBK2(200.00) reversed, in cents
  assert.equal(saved.budgets['C1|2026-10-03'], -80000);

  res = run(['budget', '--customer', 'C1', '--date', '2026-10-03', '--state', state]);
  assert.equal(JSON.parse(res.stdout).net, -80000);
});

test('cli rollback exits 22 on budget violation and changes nothing', () => {
  const { channel, clearing, bank, state } = setup();
  run(['load', '--channel', channel, '--clearing', clearing, '--bank', bank, '--state', state]);
  run(['budget', '--customer', 'C1', '--date', '2026-10-03', '--limit', '100.00', '--state', state]);
  const res = run(['rollback', '--batch', 'BCH1', '--state', state]);
  assert.equal(res.status, 22);
  assert.equal(JSON.parse(res.stderr).code, 22);
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  assert.ok(saved.batches.every((b) => b.status === 'active'));
  assert.deepEqual(saved.budgets, {});
});

test('cli rollback exits 20 on circular dependency', () => {
  const { state } = setup();
  fs.writeFileSync(state, JSON.stringify({
    batches: [
      { batchId: 'A', layer: 'channel', parentId: 'B', customerId: 'C1', amount: 1, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
      { batchId: 'B', layer: 'clearing', parentId: 'A', customerId: 'C1', amount: 1, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
    ],
    adjustments: [], budgets: {}, limits: {}, journal: null,
  }));
  const res = run(['rollback', '--batch', 'A', '--state', state]);
  assert.equal(res.status, 20);
  assert.equal(JSON.parse(res.stderr).code, 20);
});

test('cli rollback exits 21 on orphan bank receipt', () => {
  const { state } = setup();
  fs.writeFileSync(state, JSON.stringify({
    batches: [
      { batchId: 'BK9', layer: 'bank', parentId: 'NOPE', customerId: 'C1', amount: 1, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
    ],
    adjustments: [], budgets: {}, limits: {}, journal: null,
  }));
  const res = run(['rollback', '--batch', 'BK9', '--state', state]);
  assert.equal(res.status, 21);
  assert.equal(JSON.parse(res.stderr).code, 21);
});

test('cli crash-after-budget then resume: no double deduction', () => {
  const { channel, clearing, bank, state } = setup();
  run(['load', '--channel', channel, '--clearing', clearing, '--bank', bank, '--state', state]);
  let res = run(['rollback', '--batch', 'BCL1', '--state', state, '--crash-after-budget', '1']);
  assert.equal(res.status, 1); // simulated crash
  res = run(['rollback', '--batch', 'BCL1', '--state', state]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).resumed, true);
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  // BCL1(200.00)+BBK1(200.00)+BBK2(200.00) reversed exactly once, in cents
  assert.equal(saved.budgets['C1|2026-10-03'], -60000);
});
