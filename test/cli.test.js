'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../index');

// The CLI is exercised in-process through main(); spawning a child node process
// is not required to verify argument handling, exit codes and file output.

function runCli(argv, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-reserve-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  if (input !== undefined) fs.writeFileSync(inputPath, JSON.stringify(input));
  const logs = { stdout: [], stderr: [] };
  const code = main(
    argv.map((a) => (a === '$in' ? inputPath : a === '$out' ? outputPath : a)),
    { stdout: (m) => logs.stdout.push(m), stderr: (m) => logs.stderr.push(m) }
  );
  const output = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : null;
  return { code, logs, output };
}

test('CLI: valid run exits 0 and writes the output file', () => {
  const { code, logs, output } = runCli(['reserve', '$in', '$out'], {
    packages: [{ id: 'P1', limits: { travel: 1000 } }],
    reimbursements: [{ id: 'R1', category: 'travel', amount: 800 }],
  });
  assert.equal(code, 0);
  assert.deepEqual(logs.stdout, ['status: OK']);
  assert.equal(output.status, 'OK');
  assert.deepEqual(output.assignments, [
    { id: 'R1', package: 'P1', tier: 'full', reserved: 800 },
  ]);
});

test('CLI: negative amount exits 1', () => {
  const { code, logs, output } = runCli(['reserve', '$in', '$out'], {
    packages: [{ id: 'P1', limits: { travel: 1000 } }],
    reimbursements: [{ id: 'R1', category: 'travel', amount: -5 }],
  });
  assert.equal(code, 1);
  assert.match(logs.stderr.join('\n'), /negative/);
  assert.equal(output, null);
});

test('CLI: negative paid amount exits 1', () => {
  const { code, logs } = runCli(['reserve', '$in', '$out'], {
    packages: [{ id: 'P1', limits: { travel: 1000 } }],
    reimbursements: [{ id: 'R1', category: 'travel', amount: 100, paid: -1 }],
  });
  assert.equal(code, 1);
  assert.match(logs.stderr.join('\n'), /negative/);
});

test('CLI: cancelling an unknown document exits 1', () => {
  const { code, logs, output } = runCli(['reserve', '$in', '$out'], {
    packages: [{ id: 'P1', limits: { travel: 1000 } }],
    reimbursements: [{ id: 'R1', category: 'travel', amount: 100 }],
    cancellations: [{ id: 'C1', target: 'NOPE' }],
  });
  assert.equal(code, 1);
  assert.match(logs.stderr.join('\n'), /unknown reimbursement/);
  assert.equal(output, null);
});

test('CLI: missing arguments exit 1', () => {
  const { code, logs } = runCli([], undefined);
  assert.equal(code, 1);
  assert.match(logs.stderr.join('\n'), /usage/);
});

test('CLI: unreadable input exits 1', () => {
  const { code, logs } = runCli(['reserve', '$in', '$out'], undefined);
  assert.equal(code, 1);
  assert.match(logs.stderr.join('\n'), /cannot read input/);
});

test('CLI: malformed JSON input exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-reserve-'));
  const inputPath = path.join(dir, 'input.json');
  fs.writeFileSync(inputPath, '{not json');
  const logs = { stdout: [], stderr: [] };
  const code = main(['reserve', inputPath, path.join(dir, 'out.json')], {
    stdout: (m) => logs.stdout.push(m),
    stderr: (m) => logs.stderr.push(m),
  });
  assert.equal(code, 1);
  assert.match(logs.stderr.join('\n'), /cannot read input/);
});
