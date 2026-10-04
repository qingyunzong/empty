'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
}

// Spawning subprocesses is not always permitted, so the CLI is driven
// in-process through its exported run() with captured io.
function runCli(argv) {
  let stdout = '';
  let stderr = '';
  const status = run(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { status, stdout, stderr };
}

test('cli: happy path prints ledger, available credit and certificate', () => {
  const dir = tmpdir();
  const ops = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(
    ops,
    [
      '{"idemKey":"a1","type":"auth","amount":100,"seq":1,"ts":1}',
      '{"idemKey":"c1","type":"capture","ref":"a1","amount":60,"seq":2,"ts":2}',
      '{"idemKey":"r1","type":"refund","ref":"c1","amount":20,"seq":3,"ts":3}',
      '',
    ].join('\n')
  );
  const res = runCli([ops, '--wal', path.join(dir, 'w.log'), '--limit', '1000']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.available, 960);
  assert.deepEqual(out.ledger.map((ev) => ev.type), ['auth', 'capture', 'refund']);
  assert.equal(out.certificate.linearizable, true);
  assert.deepEqual(out.certificate.order, ['a1', 'c1', 'r1']);
});

test('cli: malformed frame exits 2', () => {
  const dir = tmpdir();
  const ops = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(ops, '{"idemKey":"a1","type":"auth","amount":100,"seq":1,"ts":1}\n{broken\n');
  const res = runCli([ops, '--wal', path.join(dir, 'w.log')]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /FRAME_ERROR/);
});

test('cli: invalid field exits 2', () => {
  const dir = tmpdir();
  const ops = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(ops, '{"idemKey":"a1","type":"auth","amount":-5,"seq":1,"ts":1}\n');
  const res = runCli([ops, '--wal', path.join(dir, 'w.log')]);
  assert.equal(res.status, 2);
});

test('cli: state conflict exits 3', () => {
  const dir = tmpdir();
  const ops = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(ops, '{"idemKey":"a1","type":"auth","amount":5000,"seq":1,"ts":1}\n');
  const res = runCli([ops, '--wal', path.join(dir, 'w.log'), '--limit', '1000']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /STATE_CONFLICT/);
});

test('cli: re-running the same ops file against the same WAL is idempotent', () => {
  const dir = tmpdir();
  const ops = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(
    ops,
    '{"idemKey":"a1","type":"auth","amount":100,"seq":1,"ts":1}\n' +
      '{"idemKey":"c1","type":"capture","ref":"a1","amount":60,"seq":2,"ts":2}\n'
  );
  const wal = path.join(dir, 'w.log');
  const first = JSON.parse(runCli([ops, '--wal', wal]).stdout);
  const second = runCli([ops, '--wal', wal]);
  const out2 = JSON.parse(second.stdout);
  assert.equal(first.available, 940);
  assert.equal(out2.available, 940);
  assert.equal(out2.ledger.length, 2); // no double apply
  assert.ok(out2.responses.every((r) => r.duplicate === true));
});
