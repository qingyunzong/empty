import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/compiler.js';
import { runPipeline } from '../src/runner.js';
import { main } from '../src/cli.js';

const RECORDS = [
  { id: 1, price: 10, qty: 2 },
  { id: 2, price: 20, qty: 0 },
  { id: 3, price: 250, qty: 4 },
  { id: 4, price: -5, qty: 3 },
  { id: 5, price: 40, qty: 1 },
];

const SCRIPT = [
  '#!correction',
  'map total = price * qty',
  'map price = price * 2',
  'clamp price 0 100',
  'filter qty > 0',
  'if qty >= 4 then bonus = qty * 10',
  '#!end',
].join('\n');

// Acceptance 1: five records, normal run checked against hand computation.
test('acceptance 1: five records match hand-computed corrections', () => {
  const { code } = compile(SCRIPT);
  const result = runPipeline({ records: RECORDS, code, batchSize: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.records, [
    { id: 1, price: 20, qty: 2, total: 20 },
    { id: 3, price: 100, qty: 4, total: 1000, bonus: 40 },
    { id: 4, price: 0, qty: 3, total: -15 },
    { id: 5, price: 80, qty: 1, total: 40 },
  ]);
  assert.deepEqual(
    result.batches.map((b) => [b.startIndex, b.endIndex, b.emitted]),
    [[0, 1, 1], [2, 3, 2], [4, 4, 1]],
  );
  assert.equal(result.committedThrough, 4);
});

// Acceptance 2: division by zero on the 4th record rolls back its whole
// batch; only the previously committed batch survives.
test('acceptance 2: div-by-zero on record 4 rolls back the whole batch', () => {
  const records = [
    { id: 1, price: 10, qty: 2 },
    { id: 2, price: 20, qty: 5 },
    { id: 3, price: 30, qty: 4 },
    { id: 4, price: 40, qty: 0 },
    { id: 5, price: 50, qty: 1 },
  ];
  const { code } = compile('#!correction\nmap ratio = price / qty\n#!end');
  const result = runPipeline({ records, code, batchSize: 2 });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /division by zero/);
  assert.equal(result.error.recordIndex, 3);
  assert.deepEqual(result.error.rolledBackBatch, { startIndex: 2, endIndex: 3 });
  assert.equal(result.committedThrough, 1);
  assert.equal(result.batches.length, 1);
  assert.deepEqual(result.batches[0], { batch: 0, startIndex: 0, endIndex: 1, emitted: 2, committed: true });
  assert.deepEqual(result.records, [
    { id: 1, price: 10, qty: 2, ratio: 5 },
    { id: 2, price: 20, qty: 5, ratio: 4 },
  ]);
});

// Acceptance 3: crash after the Nth bytecode (before the batch commit), then
// rerun with the state file; indices and results must equal a fault-free run.
test('acceptance 3: crash recovery matches fault-free run exactly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrector-'));
  const inputPath = path.join(dir, 'records.json');
  const scriptPath = path.join(dir, 'script.cor');
  fs.writeFileSync(inputPath, JSON.stringify(RECORDS));
  fs.writeFileSync(scriptPath, SCRIPT);

  const runCli = (statePath, extra = []) => {
    const outputPath = path.join(dir, `out-${Math.random().toString(36).slice(2)}.json`);
    const status = main(['--input', inputPath, '--script', scriptPath,
      '--batch-size', '2', '--state', statePath, '--output', outputPath, ...extra]);
    const stdout = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    return { status, stdout };
  };

  // Fault-free reference run.
  const clean = runCli(path.join(dir, 'clean-state.json'));
  assert.equal(clean.status, 0);
  const expected = JSON.parse(clean.stdout);

  // Crashing run: dies after the 40th bytecode instruction, i.e. inside
  // batch 1 (records 2..3), before that batch's commit checkpoint.
  const crashedState = path.join(dir, 'crashed-state.json');
  const crashed = runCli(crashedState, ['--crash', '40']);
  assert.equal(crashed.status, 3);

  // State file must reflect only committed batch 0 (records 0..1).
  const state = JSON.parse(fs.readFileSync(crashedState, 'utf8'));
  assert.equal(state.committedThrough, 1);
  assert.deepEqual(state.processedIndices, [0, 1]);

  // Resume: continues strictly after the last committed batch.
  const resumed = runCli(crashedState);
  assert.equal(resumed.status, 0);
  const actual = JSON.parse(resumed.stdout);

  assert.deepEqual(actual.records, expected.records);
  assert.deepEqual(actual.batches, expected.batches);
  assert.equal(actual.committedThrough, expected.committedThrough);

  // Idempotency: rerunning with the completed state file changes nothing,
  // so already-committed records are never corrected twice.
  const again = runCli(crashedState);
  assert.equal(again.status, 0);
  assert.deepEqual(JSON.parse(again.stdout).records, expected.records);
});
