'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function runCli(args, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cli-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  const stderrPath = path.join(dir, 'stderr.txt');
  const argv = [...args];
  if (input !== undefined) {
    fs.writeFileSync(inputPath, JSON.stringify(input));
    argv.push(inputPath, outputPath);
  }
  const stderrFd = fs.openSync(stderrPath, 'w');
  const proc = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', stderrFd],
  });
  fs.closeSync(stderrFd);
  const stderr = fs.readFileSync(stderrPath, 'utf8');
  const output = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : null;
  return { proc, output, stderr };
}

test('cli: node . auth writes decisions and exits 0', () => {
  const { proc, output } = runCli(['.', 'auth'], {
    sharedLimit: 1000,
    tiers: [1, 0.75, 0.5, 0.25],
    cards: [
      { id: 'A', limit: 600 },
      { id: 'B', limit: 600 },
    ],
    events: [
      { type: 'auth', id: 'r1', card: 'A', amount: 600 },
      { type: 'auth', id: 'r2', card: 'B', amount: 600 },
    ],
  });
  assert.equal(proc.status, 0);
  assert.equal(output.decisions[0].decision, 'APPROVED_FULL');
  assert.equal(output.decisions[1].decision, 'APPROVED_PARTIAL');
  assert.equal(output.decisions[1].shortfall, 300);
  assert.deepEqual(output.freezes, { shared: 900, cards: { A: 600, B: 300 } });
});

test('cli: unknown card exits with code 1', () => {
  const { proc, output, stderr } = runCli(['.', 'auth'], {
    sharedLimit: 1000,
    cards: [{ id: 'A', limit: 1000 }],
    events: [{ type: 'auth', id: 'r1', card: 'GHOST', amount: 10 }],
  });
  assert.equal(proc.status, 1);
  assert.match(stderr, /unknown card/);
  assert.equal(output, null);
});

test('cli: reversal exceeding approved amount exits with code 1', () => {
  const { proc, output, stderr } = runCli(['.', 'auth'], {
    sharedLimit: 1000,
    cards: [{ id: 'A', limit: 1000 }],
    events: [
      { type: 'auth', id: 'r1', card: 'A', amount: 100 },
      { type: 'reversal', auth: 'r1', amount: 101 },
    ],
  });
  assert.equal(proc.status, 1);
  assert.match(stderr, /exceeds remaining approved/);
  assert.equal(output, null);
});

test('cli: reversal of unknown authorization exits with code 1', () => {
  const { proc, output, stderr } = runCli(['.', 'auth'], {
    sharedLimit: 1000,
    cards: [{ id: 'A', limit: 1000 }],
    events: [{ type: 'reversal', auth: 'nope', amount: 10 }],
  });
  assert.equal(proc.status, 1);
  assert.match(stderr, /unknown authorization/);
  assert.equal(output, null);
});

test('cli: missing arguments exits with code 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cli-'));
  const stderrPath = path.join(dir, 'stderr.txt');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const proc = spawnSync(process.execPath, ['.'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', stderrFd],
  });
  fs.closeSync(stderrFd);
  assert.equal(proc.status, 1);
  assert.match(fs.readFileSync(stderrPath, 'utf8'), /usage/);
});
