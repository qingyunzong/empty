'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../lib/cli');

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through main(argv) with process.stderr captured. The real
// `node . cancel ...` entry is verified separately via the shell.
function runCli(argv) {
  let stderr = '';
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  try {
    return { status: main(argv), stderr };
  } finally {
    process.stderr.write = original;
  }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-cli-'));
}

function validInput() {
  return {
    transactions: [
      {
        id: 'tx1',
        stages: [
          { id: 's-trade', kind: 'trade', account: 'A', amount: 50, status: 'posted', dependsOn: ['s-fee'] },
          { id: 's-fee', kind: 'fee', account: 'A', amount: 50, status: 'posted', dependsOn: ['s-freeze'] },
          { id: 's-freeze', kind: 'freeze', account: 'A', amount: 100, status: 'reconciled', dependsOn: ['s-settle'] },
          { id: 's-settle', kind: 'settlement', account: 'A', amount: 100, status: 'posted', dependsOn: [] },
        ],
      },
    ],
    batches: [{ id: 'b1', domains: ['trade', 'fee', 'freeze', 'settlement'], recoverable: { A: 1000 } }],
    requests: [
      { idempotencyKey: 'k1', transactionId: 'tx1' },
      { idempotencyKey: 'k1', transactionId: 'tx1' },
      { idempotencyKey: 'k2', transactionId: 'ghost' },
    ],
  };
}

test('CLI: happy path writes output and exits 0', () => {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  fs.writeFileSync(inputPath, JSON.stringify(validInput()));

  const { status, stderr } = runCli(['cancel', inputPath, outputPath]);
  assert.equal(status, 0, stderr);

  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(output.results.length, 3);

  const [completed, replay, rejected] = output.results;
  assert.equal(completed.status, 'COMPLETED');
  assert.deepEqual(
    completed.sequence.map((entry) => [entry.kind, entry.action]),
    [
      ['settlement', 'delete'],
      ['freeze', 'reversal'],
      ['fee', 'delete'],
      ['trade', 'delete'],
    ],
  );
  assert.equal(replay.status, 'COMPLETED');
  assert.equal(replay.replayed, true);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'TRANSACTION_NOT_FOUND');

  assert.deepEqual(output.state.transactions[0].compensated, [
    's-settle',
    's-freeze',
    's-fee',
    's-trade',
  ]);
});

test('CLI: malformed JSON exits 1', () => {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.json');
  fs.writeFileSync(inputPath, '{ not json');
  const { status, stderr } = runCli(['cancel', inputPath, path.join(dir, 'out.json')]);
  assert.equal(status, 1);
  assert.match(stderr, /error:/);
});

test('CLI: schema violation exits 1', () => {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.json');
  const bad = validInput();
  bad.transactions[0].stages[0].amount = -5;
  fs.writeFileSync(inputPath, JSON.stringify(bad));
  const { status, stderr } = runCli(['cancel', inputPath, path.join(dir, 'out.json')]);
  assert.equal(status, 1);
  assert.match(stderr, /invalid input/);
});

test('CLI: dependency cycle exits 1', () => {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.json');
  const bad = validInput();
  bad.transactions[0].stages[3].dependsOn = ['s-trade'];
  fs.writeFileSync(inputPath, JSON.stringify(bad));
  const { status, stderr } = runCli(['cancel', inputPath, path.join(dir, 'out.json')]);
  assert.equal(status, 1);
  assert.match(stderr, /cycle/);
});

test('CLI: missing input file exits 1', () => {
  const dir = tmpdir();
  const { status } = runCli(['cancel', path.join(dir, 'nope.json'), path.join(dir, 'out.json')]);
  assert.equal(status, 1);
});

test('CLI: wrong arguments exit 1 with usage', () => {
  for (const argv of [[], ['cancel'], ['cancel', 'a.json'], ['cancel', 'a', 'b', 'c'], ['bogus', 'a', 'b']]) {
    const { status, stderr } = runCli(argv);
    assert.equal(status, 1, JSON.stringify(argv));
    assert.match(stderr, /usage: node \. cancel/);
  }
});
