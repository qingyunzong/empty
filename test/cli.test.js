'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { main } = require('../src/cli');
const { HEADER_LEN } = require('../src/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planline-cli-'));
}

function capture() {
  let text = '';
  const stream = new Writable({
    write(chunk, enc, cb) {
      text += chunk.toString('utf8');
      cb();
    },
  });
  return {
    stream,
    parse: () => (text ? JSON.parse(text) : null),
  };
}

// Runs the CLI in-process (the sandbox forbids spawning child processes);
// bin/plan.js maps this exact return value onto process.exitCode.
function plan(args) {
  const stdout = capture();
  const stderr = capture();
  const status = main(args, { stdout: stdout.stream, stderr: stderr.stream });
  return { status, stdout: stdout.parse(), stderr: stderr.parse() };
}

test('happy path: init, add, list, checkpoint, rollback, schedule', () => {
  const dir = tmpdir();
  assert.deepEqual(plan(['init', dir]).stdout.ok, true);

  const add = plan(['add', dir, '--order', '{"id":"WO-1","quantity":10,"due":5,"machine":"M1"}']);
  assert.equal(add.status, 0);
  assert.equal(add.stdout.chunk, 0);

  const orderFile = path.join(dir, 'order.json');
  fs.writeFileSync(orderFile, '{"id":"WO-2","quantity":6,"due":3,"machine":"M2"}');
  const add2 = plan(['add', dir, '--order', `@${orderFile}`]);
  assert.equal(add2.status, 0);
  assert.equal(add2.stdout.chunk, 1);

  const list = plan(['list', dir]);
  assert.deepEqual(list.stdout.loads, { M1: 10, M2: 6 });
  assert.deepEqual(
    list.stdout.orders.map((o) => o.id),
    ['WO-1', 'WO-2'],
  );

  const cp = plan(['checkpoint', dir, 'cp1']);
  assert.deepEqual(cp.stdout.checkpoint, { name: 'cp1', chunks: 2 });

  const rb = plan(['rollback', dir, 'cp1']);
  assert.deepEqual(rb.stdout.rolledBackTo, { name: 'cp1', chunks: 2 });

  const sched = plan(['schedule', dir, '--capacity', '{"M1":5,"M2":3}']);
  assert.equal(sched.status, 0);
  assert.deepEqual(
    sched.stdout.sequence.map((s) => s.id),
    ['WO-2', 'WO-1'],
  );
  assert.equal(sched.stdout.makespan, 4);

  const verify = plan(['verify', dir]);
  assert.equal(verify.status, 0);
  assert.equal(verify.stdout.chunks, 2);
});

test('infeasible schedule exits 4 with E_CAPACITY', () => {
  const dir = tmpdir();
  plan(['init', dir]);
  plan(['add', dir, '--order', '{"id":"A","quantity":10,"due":1,"machine":"M1"}']);
  plan(['add', dir, '--order', '{"id":"B","quantity":10,"due":1,"machine":"M1"}']);
  const res = plan(['schedule', dir, '--capacity', '{"M1":5}']);
  assert.equal(res.status, 4);
  assert.equal(res.stdout, null);
  assert.equal(res.stderr.ok, false);
  assert.equal(res.stderr.error.code, 'E_CAPACITY');
});

test('corrupted chunk exits 2 with E_CRC and reports the chunk number', () => {
  const dir = tmpdir();
  plan(['init', dir]);
  plan(['add', dir, '--order', '{"id":"A","quantity":4,"due":9,"machine":"M1"}']);
  plan(['add', dir, '--order', '{"id":"B","quantity":4,"due":9,"machine":"M1"}']);

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const dataPath = path.join(dir, 'data.bin');
  const fd = fs.openSync(dataPath, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, manifest.chunks[1].offset + HEADER_LEN);
  one[0] ^= 0x01;
  fs.writeSync(fd, one, 0, 1, manifest.chunks[1].offset + HEADER_LEN);
  fs.closeSync(fd);

  const res = plan(['verify', dir]);
  assert.equal(res.status, 2);
  assert.equal(res.stderr.error.code, 'E_CRC');
  assert.equal(res.stderr.error.chunk, 1);
  assert.deepEqual(res.stderr.error.prefixOrders, ['A']);
});

test('broken manifest index exits 3 with E_INDEX', () => {
  const dir = tmpdir();
  plan(['init', dir]);
  plan(['add', dir, '--order', '{"id":"A","quantity":4,"due":9,"machine":"M1"}']);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.chunks[0].length = 3;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const res = plan(['list', dir]);
  assert.equal(res.status, 3);
  assert.equal(res.stderr.error.code, 'E_INDEX');
});

test('usage errors exit 1 with E_USAGE', () => {
  const res = plan(['bogus-command']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr.error.code, 'E_USAGE');
});
