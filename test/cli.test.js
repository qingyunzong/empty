'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

// Spawn the CLI as a real subprocess. stdout/stderr are captured via temp
// files because pipe capture is unreliable in restricted sandboxes.
function runCli(args) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
    const outFile = path.join(dir, 'stdout.txt');
    const errFile = path.join(dir, 'stderr.txt');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', (status) => {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve({
        status,
        stdout: fs.readFileSync(outFile, 'utf8'),
        stderr: fs.readFileSync(errFile, 'utf8'),
      });
    });
  });
}

function writeTmp(data) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')), 'input.json');
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

const VALID = {
  machines: ['M1', 'M2'],
  setupTime: 1,
  jobs: [
    { id: 'A', release: 0, duration: 2, deadline: 8, family: 'x' },
    { id: 'B', release: 0, duration: 2, deadline: 8, family: 'y' },
  ],
};

test('CLI solves a feasible instance with exit code 0', async () => {
  const r = await runCli(['schedule', writeTmp(VALID), '--budget', '1000']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'optimal');
  assert.ok(Array.isArray(out.schedule));
});

test('CLI reports unknown when the budget is exhausted', async () => {
  const r = await runCli(['schedule', writeTmp(VALID), '--budget', '0']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'unknown');
  assert.ok(out.pendingVariables.length > 0);
});

test('CLI exits 2 when the input file is missing', async () => {
  const r = await runCli(['schedule', 'does-not-exist.json', '--budget', '10']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read input file/);
});

test('CLI exits 2 on non-integer times', async () => {
  const file = writeTmp({ machines: ['M1'], jobs: [{ id: 'A', release: 0.5, duration: 2, deadline: 5 }] });
  const r = await runCli(['schedule', file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be an integer/);
});

test('CLI exits 2 on undefined machine reference', async () => {
  const file = writeTmp({ machines: ['M1'], jobs: [{ id: 'A', release: 0, duration: 2, deadline: 5, machines: ['M9'] }] });
  const r = await runCli(['schedule', file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /undefined machine/);
});

test('CLI exits 2 when required fields are missing', async () => {
  const r = await runCli(['schedule', writeTmp({ machines: ['M1'] })]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing "jobs" array/);
  const r2 = await runCli(['schedule', writeTmp({ machines: ['M1'], jobs: [{ id: 'A', release: 0, deadline: 5 }] })]);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /missing "duration"/);
});
