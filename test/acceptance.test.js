import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-correct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

// Note: this sandbox swallows stdout/stderr of spawned node processes, so the
// CLI report is always collected through --output files.
function runCli(args, outputFile) {
  const fullArgs = [...args, '--output', outputFile];
  const proc = spawnSync(process.execPath, [CLI, ...fullArgs], { encoding: 'utf8' });
  const report = fs.existsSync(outputFile)
    ? JSON.parse(fs.readFileSync(outputFile, 'utf8'))
    : null;
  return { status: proc.status, stderr: proc.stderr, report };
}

const SCRIPT = [
  '#!correction main',
  'mul amount price qty',
  'clamp score 0 100',
  'filter status == "active"',
  'if amount > 50 goto big',
  'jmp done',
  'label big',
  'add amount amount 5',
  'label done',
  'div per amount qty',
  '',
].join('\n');

const RECORDS = [
  { id: 'a', price: 10, qty: 2, score: 150, status: 'active' },
  { id: 'b', price: 5, qty: 4, score: -20, status: 'active' },
  { id: 'c', price: 7, qty: 3, score: 50, status: 'inactive' },
  { id: 'd', price: 100, qty: 1, score: 80, status: 'active' },
  { id: 'e', price: 3, qty: 10, score: 95, status: 'active' },
];

// Hand-computed expectations for SCRIPT over RECORDS:
//   amount = price * qty; score clamped to [0, 100]; inactive dropped;
//   amount > 50 gets +5 bonus; per = amount / qty.
const EXPECTED_RECORDS = [
  { seq: 0, record: { id: 'a', price: 10, qty: 2, score: 100, status: 'active', amount: 20, per: 10 } },
  { seq: 1, record: { id: 'b', price: 5, qty: 4, score: 0, status: 'active', amount: 20, per: 5 } },
  { seq: 3, record: { id: 'd', price: 100, qty: 1, score: 80, status: 'active', amount: 105, per: 105 } },
  { seq: 4, record: { id: 'e', price: 3, qty: 10, score: 95, status: 'active', amount: 30, per: 3 } },
];

const EXPECTED_BATCHES = [
  { index: 0, startSeq: 0, endSeq: 1, count: 2, committed: true },
  { index: 1, startSeq: 2, endSeq: 3, count: 2, committed: true },
  { index: 2, startSeq: 4, endSeq: 4, count: 1, committed: true },
];

test('acceptance 1: five records match the hand-computed result', (t) => {
  const dir = makeTmp(t);
  const input = path.join(dir, 'records.json');
  const script = path.join(dir, 'correction.txt');
  const output = path.join(dir, 'out.json');
  writeJson(input, RECORDS);
  fs.writeFileSync(script, SCRIPT, 'utf8');

  const proc = runCli(['--input', input, '--script', script, '--batch-size', '2'], output);
  assert.equal(proc.status, 0, proc.stderr);
  const report = proc.report;
  assert.equal(report.ok, true);
  assert.deepEqual(report.records, EXPECTED_RECORDS);
  assert.deepEqual(report.batches, EXPECTED_BATCHES);
});

test('acceptance 2: division by zero in record #4 rolls back its whole batch', (t) => {
  const dir = makeTmp(t);
  const input = path.join(dir, 'records.json');
  const script = path.join(dir, 'correction.txt');
  const output = path.join(dir, 'out.json');
  writeJson(input, [
    { id: 'r0', price: 4, qty: 2 },
    { id: 'r1', price: 6, qty: 3 },
    { id: 'r2', price: 1, qty: 5 },
    { id: 'r3', price: 9, qty: 0 },
    { id: 'r4', price: 8, qty: 2 },
  ]);
  fs.writeFileSync(script, '#!correction main\nmul amount price qty\ndiv per amount qty\n', 'utf8');

  const proc = runCli(['--input', input, '--script', script, '--batch-size', '3'], output);
  assert.equal(proc.status, 1, proc.stderr);
  const report = proc.report;
  assert.equal(report.ok, false);
  assert.equal(report.error.type, 'DivByZero');
  assert.equal(report.error.seq, 3);
  assert.equal(report.committedBoundary, 3);
  // Only the first committed batch survives; the failed batch is fully undone.
  assert.deepEqual(report.records, [
    { seq: 0, record: { id: 'r0', price: 4, qty: 2, amount: 8, per: 4 } },
    { seq: 1, record: { id: 'r1', price: 6, qty: 3, amount: 18, per: 6 } },
    { seq: 2, record: { id: 'r2', price: 1, qty: 5, amount: 5, per: 1 } },
  ]);
  assert.deepEqual(report.batches, [
    { index: 0, startSeq: 0, endSeq: 2, count: 3, committed: true },
  ]);
});

test('acceptance 3: crash recovery reproduces the no-fault run exactly', (t) => {
  const dir = makeTmp(t);
  const input = path.join(dir, 'records.json');
  const script = path.join(dir, 'correction.txt');
  const stateFile = path.join(dir, 'state.json');
  writeJson(input, RECORDS);
  fs.writeFileSync(script, SCRIPT, 'utf8');

  // Reference: single no-fault run.
  const reference = runCli(
    ['--input', input, '--script', script, '--batch-size', '2'],
    path.join(dir, 'ref.json'),
  );
  assert.equal(reference.status, 0, reference.stderr);
  const expected = reference.report;

  // Crash after the 20th executed bytecode instruction: batch 0 (records 0-1,
  // 7 instructions each) is committed; the crash lands mid-batch-1, before
  // that batch's checkpoint/commit.
  const crashed = runCli([
    '--input', input, '--script', script, '--batch-size', '2',
    '--crash', '20', '--state', stateFile,
  ], path.join(dir, 'crash.json'));
  assert.equal(crashed.status, 2, crashed.stderr);
  const crashReport = crashed.report;
  assert.equal(crashReport.ok, false);
  assert.equal(crashReport.crashed, true);
  assert.equal(crashReport.afterInstruction, 20);
  assert.equal(crashReport.committedBoundary, 2);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.committed, 2);
  assert.deepEqual(state.results.map((r) => r.seq), [0, 1]);

  // Resume: must continue strictly after the committed boundary and must not
  // re-apply corrections to already-committed records.
  const resumed = runCli([
    '--input', input, '--script', script, '--batch-size', '2',
    '--state', stateFile,
  ], path.join(dir, 'resumed.json'));
  assert.equal(resumed.status, 0, resumed.stderr);
  const recovered = resumed.report;
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.records, expected.records);
  assert.deepEqual(recovered.batches, expected.batches);
  assert.deepEqual(recovered.records.map((r) => r.seq), [0, 1, 3, 4]);

  // Re-running once more against the fully committed state is a no-op.
  const again = runCli([
    '--input', input, '--script', script, '--batch-size', '2',
    '--state', stateFile,
  ], path.join(dir, 'again.json'));
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.report.records, expected.records);
});
