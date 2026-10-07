'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function spawnCli(args, dir) {
  const stderrPath = path.join(dir, 'stderr.txt');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', stderrFd],
  });
  fs.closeSync(stderrFd);
  return { ...res, stderr: fs.readFileSync(stderrPath, 'utf8') };
}

function runCli(inputObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-cli-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  if (inputObj !== null) fs.writeFileSync(inputPath, JSON.stringify(inputObj));
  const res = spawnCli(['.', 'history', inputPath, outputPath], dir);
  const output = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : null;
  return { res, output };
}

test('CLI history writes commit order, statuses, balances and conflictCycle', () => {
  const { res, output } = runCli({
    orders: [{ orderId: 'o1', charged: 1000, frozen: 500 }],
    requests: [
      { id: 'u1', type: 'unfreeze', orderId: 'o1', amount: 500, arrival: 1 },
      { id: 'r1', type: 'refund', orderId: 'o1', amount: 300, arrival: 2 },
      { id: 'v1', type: 'void', orderId: 'o1', arrival: 3 },
    ],
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(output.status, 'OK');
  assert.deepEqual(output.commitOrder, ['r1', 'v1', 'u1']);
  assert.equal(output.requests.length, 3);
  assert.equal(output.balances.length, 3);
  assert.equal(output.conflictCycle, null);
});

test('CLI exits 1 for unknown order', () => {
  const { res, output } = runCli({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ id: 'r1', type: 'refund', orderId: 'ghost', amount: 10 }],
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown order/);
  assert.equal(output, null);
});

test('CLI exits 1 for illegal amount', () => {
  const { res, output } = runCli({
    orders: [{ orderId: 'o1', charged: 100 }],
    requests: [{ id: 'r1', type: 'refund', orderId: 'o1', amount: -3 }],
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /illegal amount/);
  assert.equal(output, null);
});

test('CLI exits 1 for malformed JSON input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-cli-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  fs.writeFileSync(inputPath, '{not json');
  const res = spawnCli(['.', 'history', inputPath, outputPath], dir);
  assert.equal(res.status, 1);
});

test('CLI exits 2 on usage error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-cli-'));
  const res = spawnCli(['.'], dir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/);
});
