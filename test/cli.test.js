'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createArchive } = require('../lib/archive');
const { tmpdir, corruptByte } = require('../testutil/helpers');

const CLI = path.join(__dirname, '..', 'cli.js');
const BUFFERS = [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(16, 3)];

// The sandbox denies piped stdio for spawned children, so capture output
// through temporary files instead.
function runCli(args, inputBuffer) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-cli-'));
    const outFile = path.join(dir, 'out');
    const errFile = path.join(dir, 'err');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    let stdin = 'ignore';
    let inFd;
    if (inputBuffer) {
      const inFile = path.join(dir, 'in');
      fs.writeFileSync(inFile, inputBuffer);
      inFd = fs.openSync(inFile, 'r');
      stdin = inFd;
    }
    const child = spawn(process.execPath, [CLI, ...args], { stdio: [stdin, outFd, errFd] });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      if (inFd !== undefined) fs.closeSync(inFd);
      resolve({
        status: code,
        stdout: fs.readFileSync(outFile, 'utf8'),
        stderr: fs.readFileSync(errFile, 'utf8'),
      });
    });
  });
}

function setup() {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  const good = path.join(root, 'good');
  createArchive(arc, BUFFERS);
  createArchive(good, BUFFERS);
  return { root, arc, good };
}

test('CLI: node cli.js planRepair arc good 1024 prints deterministic JSON plan', async () => {
  const { arc, good } = setup();
  corruptByte(arc, 1, 0);
  const res = await runCli(['planRepair', arc, good, '1024']);
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.repairs.map((r) => r.index), [1]);
  assert.equal(plan.budget.maxBytes, 1024);
  assert.equal(plan.budget.usedBytes, 16);
  const again = await runCli(['planRepair', arc, good, '1024']);
  assert.equal(again.stdout, res.stdout);
});

test('CLI: full repair round-trip via planRepair + applyPlan + verify', async () => {
  const { root, arc, good } = setup();
  corruptByte(arc, 0, 5);
  corruptByte(arc, 2, 1);

  let res = await runCli(['verify', arc]);
  assert.equal(res.status, 1);
  assert.deepEqual(JSON.parse(res.stdout).damaged, [0, 2]);

  res = await runCli(['planRepair', arc, good, '1024']);
  assert.equal(res.status, 0, res.stderr);
  const planFile = path.join(root, 'plan.json');
  fs.writeFileSync(planFile, res.stdout);

  res = await runCli(['applyPlan', arc, planFile]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).applied, 2);

  res = await runCli(['verify', arc]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).ok, true);
});

test('CLI: inspect prints per-block details as JSON on stdout', async () => {
  const { arc } = setup();
  corruptByte(arc, 2, 2);
  const res = await runCli(['inspect', arc]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.blockCount, 3);
  assert.deepEqual(report.damaged, [2]);
  assert.equal(report.details[2].status, 'damaged');
});

test('CLI: invalid budget prints ERR_BUDGET JSON on stderr', async () => {
  const { arc, good } = setup();
  corruptByte(arc, 0, 0);
  const res = await runCli(['planRepair', arc, good, 'abc']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'ERR_BUDGET');
});

test('CLI: conflicting sources print ERR_SOURCE JSON on stderr', async () => {
  const { root, arc, good } = setup();
  corruptByte(arc, 1, 0);
  fs.rmSync(good, { recursive: true });
  const srcA = path.join(good, 'srcA');
  const srcB = path.join(good, 'srcB');
  createArchive(srcA, BUFFERS);
  createArchive(srcB, [Buffer.alloc(16, 1), Buffer.alloc(16, 9), Buffer.alloc(16, 3)]);
  const expected = JSON.parse(fs.readFileSync(path.join(arc, 'manifest.json'), 'utf8')).blocks[1].sha256;
  const manifestB = JSON.parse(fs.readFileSync(path.join(srcB, 'manifest.json'), 'utf8'));
  manifestB.blocks[1].sha256 = expected;
  fs.writeFileSync(path.join(srcB, 'manifest.json'), JSON.stringify(manifestB, null, 2) + '\n');

  const res = await runCli(['planRepair', arc, good, '1024']);
  assert.equal(res.status, 2);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'ERR_SOURCE');
});

test('CLI: missing archive prints ERR_IO JSON on stderr', async () => {
  const res = await runCli(['inspect', path.join(tmpdir(), 'nope')]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error.code, 'ERR_IO');
});

test('CLI: create builds an archive from stdin', async () => {
  const root = tmpdir();
  const dir = path.join(root, 'made');
  const payload = Buffer.alloc(40, 7);
  const res = await runCli(['create', dir, '16'], payload);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).blocks, 3);
  const verify = await runCli(['verify', dir]);
  assert.equal(verify.status, 0);
  assert.equal(JSON.parse(verify.stdout).ok, true);
});
