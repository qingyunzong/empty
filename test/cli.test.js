'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cli-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  const stderrPath = path.join(dir, 'stderr.txt');
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const quoted = [inputPath, outputPath].map((p) => `'${p}'`).join(' ');
  const proc = spawnSync(`node . auth ${quoted} 2> '${stderrPath}'`, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  });
  const output = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : null;
  const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
  return { proc, output, stderr };
}

test('CLI: node . auth input.json output.json writes decisions and exits 0', () => {
  const { proc, output, stderr } = runCli({
    sharedLimit: 1000,
    cards: { A: { limit: 600 }, B: { limit: 500 } },
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 400 },
      { type: 'auth', id: 'a2', card: 'B', amount: 700 },
    ],
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(output.status, 'OK');
  assert.equal(output.decisions.length, 2);
  assert.equal(output.decisions[1].status, 'PARTIAL');
  assert.equal(output.decisions[1].pendingDiff, 350);
  assert.equal(output.freezes.shared.used, 750);
});

test('CLI: unknown card exits with code 1 and writes no output', () => {
  const { proc, output, stderr } = runCli({
    sharedLimit: 100,
    cards: { A: { limit: 100 } },
    operations: [{ type: 'auth', id: 'x', card: 'ZZZ', amount: 10 }],
  });
  assert.equal(proc.status, 1);
  assert.match(stderr, /unknown card: ZZZ/);
  assert.equal(output, null);
});

test('CLI: reversal exceeding the original approval exits with code 1', () => {
  const { proc, output, stderr } = runCli({
    sharedLimit: 100,
    cards: { A: { limit: 100 } },
    operations: [
      { type: 'auth', id: 'a1', card: 'A', amount: 50 },
      { type: 'reverse', authId: 'a1', amount: 60 },
    ],
  });
  assert.equal(proc.status, 1);
  assert.match(stderr, /exceeds remaining approved/);
  assert.equal(output, null);
});

test('CLI: usage error exits with code 2', () => {
  const stderrPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cli-')), 'stderr.txt');
  const proc = spawnSync(`node . 2> '${stderrPath}'`, { cwd: ROOT, encoding: 'utf8', shell: true });
  assert.equal(proc.status, 2);
  assert.match(fs.readFileSync(stderrPath, 'utf8'), /usage: node \. auth/);
});
