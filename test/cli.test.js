'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../index');

function cli(argv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-'));
  const paths = {
    input: path.join(dir, 'input.json'),
    output: path.join(dir, 'output.json'),
  };
  const args = argv.map((a) => (paths[a] !== undefined ? paths[a] : a));
  let stderr = '';
  const code = main(args, { stderr: (msg) => { stderr += msg; } });
  const output = fs.existsSync(paths.output)
    ? JSON.parse(fs.readFileSync(paths.output, 'utf8'))
    : null;
  return { code, stderr, output, paths };
}

function cliWithInput(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-'));
  const inPath = path.join(dir, 'input.json');
  const outPath = path.join(dir, 'output.json');
  fs.writeFileSync(inPath, JSON.stringify(input));
  let stderr = '';
  const code = main(['allocate', inPath, outPath], { stderr: (msg) => { stderr += msg; } });
  const output = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
    : null;
  return { code, stderr, output };
}

const baseInput = () => ({
  totalAmount: 10000,
  costCenters: [
    { id: 'A', tiers: [20, 30, 40, 50] },
    { id: 'B', tiers: [20, 30, 40, 50] },
    { id: 'C', tiers: [20, 30, 40, 50] },
  ],
});

test('CLI allocate writes output file and exits 0', () => {
  const { code, output } = cliWithInput(baseInput());
  assert.equal(code, 0);
  assert.equal(output.status, 'FEASIBLE');
  assert.ok(Array.isArray(output.allocation));
  assert.ok(Array.isArray(output.trace));
  assert.equal(typeof output.lockedAmount, 'number');
  assert.equal(typeof output.pendingAmount, 'number');
});

test('CLI exits 1 when explicit ratios do not sum to 100', () => {
  const input = baseInput();
  input.adjustments = [{ id: 'ADJ-1', ratios: { A: 30, B: 30, C: 30 } }];
  const { code, stderr, output } = cliWithInput(input);
  assert.equal(code, 1);
  assert.match(stderr, /sum to 90, expected 100/);
  assert.equal(output, null);
});

test('CLI exits 1 when cancelling an already-cancelled document', () => {
  const input = baseInput();
  input.adjustments = [{ id: 'ADJ-1', set: { C: 30 } }];
  input.cancellations = [{ target: 'ADJ-1' }, { target: 'ADJ-1' }];
  const { code, stderr } = cliWithInput(input);
  assert.equal(code, 1);
  assert.match(stderr, /already cancelled/);
});

test('CLI exits 1 when cancelling an unknown document', () => {
  const input = baseInput();
  input.cancellations = [{ target: 'NOPE' }];
  const { code, stderr } = cliWithInput(input);
  assert.equal(code, 1);
  assert.match(stderr, /not found/);
});

test('CLI exits 2 on bad usage or unreadable input', () => {
  const usage = cli([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /usage/);
  const missing = cli(['allocate', 'input', 'output']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /cannot read input/);
});
