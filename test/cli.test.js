'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'retry-cli-'));
}

const VALID = {
  accounts: [{ id: 'A', limit: 100 }],
  batches: [
    { id: 'B1', start: '2026-10-06T09:00:00Z', end: '2026-10-06T10:00:00Z' },
    { id: 'B2', start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z' },
  ],
  transactions: [
    { id: 'T1', account: 'A', amount: 60 },
    { id: 'T2', account: 'A', amount: 60 },
    { id: 'T3', account: 'A', amount: 40 },
  ],
};

function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-cli-stderr-'));
  const errFile = path.join(dir, 'stderr.txt');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync(process.execPath, ['.', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', errFd],
  });
  fs.closeSync(errFd);
  return { status: res.status, stderr: fs.readFileSync(errFile, 'utf8') };
}

test('CLI: node . retry input.json output.json exits 0 and writes plan', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  const output = path.join(dir, 'output.json');
  fs.writeFileSync(input, JSON.stringify(VALID));
  const res = run(['retry', input, output]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(out.status, 'SAT');
  assert.equal(out.plan.flatMap((b) => b.retries).length, 3);
});

test('CLI: UNSAT input exits 0 with conflict explanation', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  const output = path.join(dir, 'output.json');
  fs.writeFileSync(input, JSON.stringify({
    ...VALID,
    accounts: [{ id: 'A', limit: 50 }],
    transactions: [
      { id: 'T1', account: 'A', amount: 40 },
      { id: 'T2', account: 'A', amount: 40 },
      { id: 'T3', account: 'A', amount: 40 },
    ],
  }));
  const res = run(['retry', input, output]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(out.status, 'UNSAT');
  assert.deepEqual(out.conflict, [
    { account: 'A', batch: 'B1' },
    { account: 'A', batch: 'B2' },
  ]);
});

test('CLI: malformed JSON exits 1', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  fs.writeFileSync(input, '{not json');
  const res = run(['retry', input, path.join(dir, 'output.json')]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid JSON/);
});

test('CLI: schema violations exit 1', () => {
  const dir = tmpdir();
  const badCases = [
    { ...VALID, accounts: [] },
    { ...VALID, transactions: [{ id: 'T1', account: 'NOPE', amount: 1 }] },
    { ...VALID, transactions: [{ id: 'T1', account: 'A', amount: -5 }] },
    { ...VALID, transactions: [{ id: 'T1', account: 'A', amount: 1, windows: ['BX'] }] },
    { ...VALID, cancellations: ['GHOST'] },
    { ...VALID, batches: [{ id: 'B1', start: 'x', end: 'y' }] },
  ];
  for (const [i, data] of badCases.entries()) {
    const input = path.join(dir, `bad${i}.json`);
    fs.writeFileSync(input, JSON.stringify(data));
    const res = run(['retry', input, path.join(dir, `out${i}.json`)]);
    assert.equal(res.status, 1, `case ${i} should exit 1: ${JSON.stringify(data)}`);
    assert.match(res.stderr, /error:/);
  }
});

test('CLI: missing input file and bad usage exit 1', () => {
  const dir = tmpdir();
  assert.equal(run(['retry', path.join(dir, 'nope.json'), path.join(dir, 'o.json')]).status, 1);
  assert.equal(run(['retry']).status, 1);
  assert.equal(run(['bogus', 'a', 'b']).status, 1);
});

test('CLI: crash-state input recovers to PENDING in output', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  const output = path.join(dir, 'output.json');
  fs.writeFileSync(input, JSON.stringify({
    ...VALID,
    transactions: [{ id: 'T1', account: 'A', amount: 50 }],
    state: {
      retries: { r1: { txId: 'T1', batchId: 'B1', state: 'RUNNING', freezeCommitted: false } },
    },
  }));
  const res = run(['retry', input, output]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(out.recovered, [{ tx: 'T1', batch: 'B1', state: 'PENDING' }]);
});
