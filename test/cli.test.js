'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

function cli(args) {
  return spawnSync(process.execPath, ['.', ...args], { cwd: root, encoding: 'utf8' });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-retry-'));
}

const goodInput = {
  accounts: [{ id: 'A', limit: 100 }],
  batches: [
    { id: 'B1', start: '2026-10-03T00:00:00Z', end: '2026-10-03T01:00:00Z' },
    { id: 'B2', start: '2026-10-03T02:00:00Z', end: '2026-10-03T03:00:00Z' },
  ],
  transactions: [
    { id: 'T1', account: 'A', amount: 50 },
    { id: 'T2', account: 'A', amount: 50, failures: ['B1'] },
    { id: 'T3', account: 'A', amount: 50 },
  ],
};

test('CLI retry writes output and exits 0', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  const output = path.join(dir, 'output.json');
  fs.writeFileSync(input, JSON.stringify(goodInput));
  const r = cli(['retry', input, output]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(out.status, 'OK');
  assert.equal(out.transactions.length, 3);
  const t2 = out.transactions.find((t) => t.id === 'T2');
  assert.deepEqual(t2.attempts.map((a) => a.batch), ['B1', 'B2']);
});

test('CLI exits 1 on malformed JSON', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  fs.writeFileSync(input, '{ not json');
  const r = cli(['retry', input, path.join(dir, 'output.json')]);
  assert.equal(r.status, 1);
});

test('CLI exits 1 on missing input file', () => {
  const dir = tmpdir();
  const r = cli(['retry', path.join(dir, 'nope.json'), path.join(dir, 'output.json')]);
  assert.equal(r.status, 1);
});

test('CLI exits 1 on schema violations', () => {
  const cases = [
    { ...goodInput, transactions: [{ id: 'T1', account: 'NOPE', amount: 1 }] },
    { ...goodInput, transactions: [{ id: 'T1', account: 'A', amount: -5 }] },
    { ...goodInput, accounts: [] },
    { ...goodInput, batches: [{ id: 'B1', start: 'bad', end: '2026-10-03T01:00:00Z' }] },
    { ...goodInput, cancellations: [{ tx: 'GHOST', atBatch: 'B1' }] },
  ];
  for (const [i, bad] of cases.entries()) {
    const dir = tmpdir();
    const input = path.join(dir, 'input.json');
    fs.writeFileSync(input, JSON.stringify(bad));
    const r = cli(['retry', input, path.join(dir, 'output.json')]);
    assert.equal(r.status, 1, `case ${i}: ${r.stdout}${r.stderr}`);
  }
});

test('CLI exits 1 on bad usage', () => {
  assert.equal(cli([]).status, 1);
  assert.equal(cli(['retry']).status, 1);
  assert.equal(cli(['bogus', 'a', 'b']).status, 1);
});
