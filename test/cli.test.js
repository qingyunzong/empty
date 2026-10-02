import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'splitpay-cli-'));
}

// Spawn the CLI with stdout/stderr redirected to files (pipes are not
// reliable in every sandboxed environment), then read the captured output.
function runCli(args) {
  const dir = tmpdir();
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve({ code, stdout: fs.readFileSync(outFile, 'utf8'), stderr: fs.readFileSync(errFile, 'utf8') });
    });
  });
}

test('CLI outputs a JSON certificate for a full three-branch flow', async () => {
  const workdir = tmpdir();
  const events = [
    { type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 100 },
    { type: 'branch_result', paymentId: 'p1', branchId: 'coupon', status: 'success', amount: 0 },
    { type: 'branch_result', paymentId: 'p1', branchId: 'points', status: 'success', amount: 55 },
  ];
  let cert;
  for (const event of events) {
    const res = await runCli(['--event', JSON.stringify(event), '--workdir', workdir]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    cert = JSON.parse(res.stdout);
  }
  assert.equal(cert.status, 'COMPLETED');
  assert.equal(cert.split.total, 155);
  assert.equal(cert.split.merchant + cert.split.fee + cert.split.tax, 155);
});

test('CLI exits 1 with {"error","message"} body on invalid input', async () => {
  const workdir = tmpdir();
  const negative = await runCli([
    '--event',
    JSON.stringify({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: -5 }),
    '--workdir',
    workdir,
  ]);
  assert.equal(negative.code, 1);
  const body = JSON.parse(negative.stdout);
  assert.equal(body.error, 'INVALID_AMOUNT');
  assert.equal(typeof body.message, 'string');

  const badJson = await runCli(['--event', '{not json', '--workdir', workdir]);
  assert.equal(badJson.code, 1);
  assert.equal(JSON.parse(badJson.stdout).error, 'INVALID_EVENT');

  const missingArgs = await runCli([]);
  assert.equal(missingArgs.code, 1);
  assert.ok(JSON.parse(missingArgs.stdout).error);
});

test('CLI accepts an event JSON file and positional args', async () => {
  const workdir = tmpdir();
  const eventFile = path.join(workdir, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 7 }));
  const res = await runCli([eventFile, workdir]);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.paymentId, 'p1');
  assert.equal(cert.branches.card.status, 'succeeded');
});
