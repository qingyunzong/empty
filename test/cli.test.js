'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');

function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reserve-cli-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  if (input !== undefined) fs.writeFileSync(inputPath, JSON.stringify(input));
  const proc = spawnSync(process.execPath, ['.', 'reserve', inputPath, outputPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const output = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : null;
  return { proc, output };
}

test('cli: successful run exits 0 and writes the result file', () => {
  const { proc, output } = runCli({
    envelopes: [{ id: 'E1', category: 'travel', limit: 500 }],
    expenses: [{ id: 'R1', category: 'travel', amount: 200 }],
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(output.status, 'OK');
  assert.deepEqual(output.assignments, [
    { expenseId: 'R1', envelopeId: 'E1', tier: 'FULL', reserved: 200 },
  ]);
  assert.equal(output.envelopes[0].used, 200);
  assert.equal(output.envelopes[0].remaining, 300);
});

test('cli: negative amount exits with code 1', () => {
  const { proc, output } = runCli({
    envelopes: [{ id: 'E1', category: 'travel', limit: 500 }],
    expenses: [{ id: 'R1', category: 'travel', amount: -1 }],
  });
  assert.equal(proc.status, 1);
  assert.equal(output, null);
});

test('cli: cancelling an unknown expense exits with code 1', () => {
  const { proc, output } = runCli({
    envelopes: [{ id: 'E1', category: 'travel', limit: 500 }],
    expenses: [{ id: 'R1', category: 'travel', amount: 10 }],
    cancellations: [{ expenseId: 'GHOST' }],
  });
  assert.equal(proc.status, 1);
  assert.equal(output, null);
});

test('cli: missing arguments exits with code 1', () => {
  const proc = spawnSync(process.execPath, ['.'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(proc.status, 1);
});

test('cli: unreadable input exits with code 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reserve-cli-'));
  const proc = spawnSync(
    process.execPath,
    ['.', 'reserve', path.join(dir, 'missing.json'), path.join(dir, 'out.json')],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(proc.status, 1);
});
