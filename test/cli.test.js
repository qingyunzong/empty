import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planstore-cli-'));
}

// Note: this sandboxed environment denies nested node processes piped stdio
// (EPERM), so the CLI's stdio is redirected through temp files instead.
let counter = 0;
function run(args, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planstore-io-'));
  const outFile = path.join(dir, 'out.txt');
  const errFile = path.join(dir, 'err.txt');
  let stdinFd = 'ignore';
  if (opts.input !== undefined) {
    const inFile = path.join(dir, 'in.txt');
    fs.writeFileSync(inFile, opts.input);
    stdinFd = fs.openSync(inFile, 'r');
  }
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], { stdio: [stdinFd, outFd, errFd] });
  if (stdinFd !== 'ignore') fs.closeSync(stdinFd);
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  counter++;
  return {
    status: r.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function runOk(args, opts) {
  const r = run(args, opts);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function runErr(args, opts) {
  const r = run(args, opts);
  assert.notEqual(r.status, 0, 'expected non-zero exit');
  return { status: r.status, error: JSON.parse(r.stderr).error };
}

const ORDERS = [
  { id: 'W03', quantity: 2, dueDate: '2026-10-05', capability: 3 },
  { id: 'W01', quantity: 1, dueDate: '2026-10-05', capability: 2 },
  { id: 'W05', quantity: 4, dueDate: '2026-10-03', capability: 1 },
  { id: 'W02', quantity: 1, dueDate: '2026-10-04', capability: 8 },
  { id: 'W04', quantity: 3, dueDate: '2026-10-03', capability: 2 },
];

test('CLI end-to-end: init, add, checkpoint, schedule, rollback, verify', () => {
  const dir = tmpdir();
  assert.deepEqual(runOk(['init', dir, '--capacity', '8']), { ok: true });

  const add1 = runOk(['add', dir], { input: JSON.stringify(ORDERS.slice(0, 3)) });
  assert.equal(add1.ok, true);
  assert.equal(add1.chunk, 0);
  assert.equal(add1.cumulativeLoad, 2 * 3 + 1 * 2 + 4 * 1);

  runOk(['checkpoint', dir, '--name', 'first']);
  runOk(['add', dir, '--orders', JSON.stringify(ORDERS.slice(3))]);

  const sched = runOk(['schedule', dir]);
  assert.deepEqual(sched.order, ['W04', 'W05', 'W02', 'W01', 'W03']);
  for (const d of sched.days) assert.ok(d.load <= 8);

  const rb = runOk(['rollback', dir, '--name', 'first']);
  assert.equal(rb.chunk, 1);
  assert.equal(rb.orders, 3);

  const v = runOk(['verify', dir]);
  assert.deepEqual(v, { ok: true, chunks: 1, orders: 3, cumulativeLoad: 12, capacity: 8 });
});

test('CLI reports E_CRC with chunk number and clean prefix on corruption', () => {
  const dir = tmpdir();
  runOk(['init', dir, '--capacity', '10']);
  runOk(['add', dir, '--orders', JSON.stringify([{ id: 'A1', quantity: 1, dueDate: '2026-10-01', capability: 2 }])]);
  runOk(['add', dir, '--orders', JSON.stringify([{ id: 'B1', quantity: 1, dueDate: '2026-10-02', capability: 3 }])]);

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const pos = manifest.chunks[1].offset + 8;
  const fd = fs.openSync(path.join(dir, 'store.dat'), 'r+');
  const orig = Buffer.alloc(1);
  fs.readSync(fd, orig, 0, 1, pos);
  fs.writeSync(fd, Buffer.from([orig[0] ^ 0x01]), 0, 1, pos);
  fs.closeSync(fd);

  const { status, error } = runErr(['verify', dir]);
  assert.equal(status, 2);
  assert.equal(error.code, 'E_CRC');
  assert.equal(error.chunk, 1);
  assert.equal(error.decodedChunks, 1);
  assert.deepEqual(error.prefixOrders, ['A1']);
  assert.equal(error.prefixCumulativeLoad, 2);
});

test('CLI reports E_CAPACITY for infeasible orders', () => {
  const dir = tmpdir();
  runOk(['init', dir, '--capacity', '5']);
  runOk(['add', dir, '--orders', JSON.stringify([{ id: 'BIG', quantity: 2, dueDate: '2026-10-01', capability: 4 }])]);
  const { status, error } = runErr(['schedule', dir]);
  assert.equal(status, 4);
  assert.equal(error.code, 'E_CAPACITY');
  assert.deepEqual(error.orders, ['BIG']);
});

test('CLI reports E_INDEX when manifest is missing', () => {
  const dir = tmpdir();
  const { status, error } = runErr(['verify', dir]);
  assert.equal(status, 3);
  assert.equal(error.code, 'E_INDEX');
});
