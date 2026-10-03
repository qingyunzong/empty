'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../src/cli');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kitting-'));
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

// In-process CLI invocation with captured streams.
function runCli(args) {
  const out = { stdout: '', stderr: '' };
  const code = run(args, {
    stdout: { write: (s) => (out.stdout += s) },
    stderr: { write: (s) => (out.stderr += s) },
  });
  return { code, ...out };
}

const INPUT = {
  substitutes: [['M1', 'M2']],
  batches: [
    { id: 'B1', material: 'M1', qty: 5, expiry: '2026-02-01', status: 'OK' },
    { id: 'B2', material: 'M2', qty: 5, expiry: '2026-03-01', status: 'OK' },
  ],
  orders: [{ id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 8 }] }],
};

test('kit command processes commands, undo/redo, and writes -o output', () => {
  const dir = makeTmp();
  const inputPath = writeJson(dir, 'input.json', INPUT);
  const commandsPath = writeJson(dir, 'commands.json', [
    { op: 'freezeBatch', batchId: 'B1' },
    { op: 'undo' },
    { op: 'redo' },
    { op: 'releaseBatch', batchId: 'B1' },
  ]);
  const outPath = path.join(dir, 'out.json');

  const run1 = runCli(['kit', inputPath, commandsPath, '-o', outPath]);
  assert.equal(run1.code, 0);
  assert.equal(run1.stderr, '');

  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.deepEqual(out.log.map((e) => [e.op, e.ok]), [
    ['freezeBatch', true],
    ['undo', true],
    ['redo', true],
    ['releaseBatch', true],
  ]);
  // Final state: B1 released again, so the order kits fully (5x M1 + 3x M2).
  assert.equal(out.state.orders[0].status, 'COMPLETE');
  assert.deepEqual(
    out.state.reservations.map((r) => [r.batchId, r.qty]),
    [['B1', 5], ['B2', 3]]
  );
});

test('command-level errors are logged, state survives, exit code stays 0', () => {
  const dir = makeTmp();
  const inputPath = writeJson(dir, 'input.json', INPUT);
  const commandsPath = writeJson(dir, 'commands.json', [
    { op: 'consumeBatch', batchId: 'B1', qty: 99 },   // over-deduction
    { op: 'freezeBatch', batchId: 'NOPE' },           // unknown batch
    { op: 'addSubstitute', from: 'M2', to: 'M1' },    // would close a cycle
    { op: 'freezeBatch', batchId: 'B1' },             // valid
  ]);
  const outPath = path.join(dir, 'out.json');

  const run1 = runCli(['kit', inputPath, commandsPath, '-o', outPath]);
  assert.equal(run1.code, 0);

  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(out.log[0].ok, false);
  assert.equal(out.log[0].code, 'OVER_DEDUCTION');
  assert.equal(out.log[1].ok, false);
  assert.equal(out.log[1].code, 'UNKNOWN_BATCH');
  assert.equal(out.log[2].ok, false);
  assert.equal(out.log[2].code, 'CYCLE');
  assert.equal(out.log[3].ok, true);
  // Only the valid freeze took effect: B1 is HOLD, order shorts on M1 remainder.
  assert.equal(out.state.batches.find((b) => b.id === 'B1').status, 'HOLD');
  assert.equal(out.state.orders[0].status, 'SHORT');
  assert.deepEqual(out.state.orders[0].certificate.missing, [
    { line: 1, material: 'M1', required: 8, reserved: 5, short: 3 },
  ]);
  assert.deepEqual(out.state.orders[0].certificate.attemptedSubstitutes, [
    { line: 1, material: 'M1', tried: [{ material: 'M1', available: 0 }, { material: 'M2', available: 5 }] },
  ]);
});

test('without -o the result goes to stdout', () => {
  const dir = makeTmp();
  const inputPath = writeJson(dir, 'input.json', INPUT);
  const commandsPath = writeJson(dir, 'commands.json', []);
  const run1 = runCli(['kit', inputPath, commandsPath]);
  assert.equal(run1.code, 0);
  const out = JSON.parse(run1.stdout);
  assert.equal(out.state.orders[0].status, 'COMPLETE');
});

test('initial input with a substitution cycle exits 1 with stderr', () => {
  const dir = makeTmp();
  const inputPath = writeJson(dir, 'input.json', {
    substitutes: [['M1', 'M2'], ['M2', 'M1']],
    batches: [],
    orders: [],
  });
  const commandsPath = writeJson(dir, 'commands.json', []);
  const run1 = runCli(['kit', inputPath, commandsPath]);
  assert.equal(run1.code, 1);
  assert.match(run1.stderr, /cycle/);
});

test('missing input file exits 1 with stderr', () => {
  const dir = makeTmp();
  const commandsPath = writeJson(dir, 'commands.json', []);
  const run1 = runCli(['kit', path.join(dir, 'nope.json'), commandsPath]);
  assert.equal(run1.code, 1);
  assert.match(run1.stderr, /cannot read file/);
});

test('malformed JSON exits 1 with stderr', () => {
  const dir = makeTmp();
  const inputPath = path.join(dir, 'input.json');
  fs.writeFileSync(inputPath, '{not json');
  const commandsPath = writeJson(dir, 'commands.json', []);
  const run1 = runCli(['kit', inputPath, commandsPath]);
  assert.equal(run1.code, 1);
  assert.match(run1.stderr, /cannot parse JSON/);
});

test('usage errors exit 2', () => {
  assert.equal(runCli([]).code, 2);
  assert.equal(runCli(['nope']).code, 2);
  assert.equal(runCli(['kit', 'only-one.json']).code, 2);
  assert.equal(runCli(['kit', 'a.json', 'b.json', '--bogus']).code, 2);
});

test('end-to-end: node src/cli.js as a real child process', (t) => {
  const dir = makeTmp();
  const inputPath = writeJson(dir, 'input.json', INPUT);
  const commandsPath = writeJson(dir, 'commands.json', [
    { op: 'freezeBatch', batchId: 'B1' },
    { op: 'undo' },
  ]);
  const outPath = path.join(dir, 'out.json');
  const child = spawnSync(process.execPath, [CLI, 'kit', inputPath, commandsPath, '-o', outPath], {
    encoding: 'utf8',
  });
  if (child.error && child.error.code === 'EPERM') {
    t.skip('sandbox does not permit spawning child processes');
    return;
  }
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.deepEqual(out.log.map((e) => [e.op, e.ok]), [['freezeBatch', true], ['undo', true]]);
  assert.equal(out.state.orders[0].status, 'COMPLETE');
});
