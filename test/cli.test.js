'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../lib/runner');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
}

function writeOps(dir, name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('happy path: exit 0, report on stdout', async () => {
  const dir = tmpdir();
  const file = writeOps(dir, 'ops.jsonl', [
    '{"idemKey":"a1","type":"auth","amount":200,"seq":1,"ts":1}',
    '{"idemKey":"c1","type":"capture","ref":"a1","amount":120,"seq":2,"ts":2}',
    '{"idemKey":"c1","type":"capture","ref":"a1","amount":120,"seq":2,"ts":2}',
  ]);
  const res = await run([file]);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.available, 880);
  assert.equal(report.captured, 120);
  assert.equal(report.replies[2].duplicate, true);
  assert.equal(report.certificate.linearization.length, 2);
});

test('frame error exits 2', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(file, '{"idemKey":"a1","type":"auth","amount":200,"seq":1,"ts":1}\n{"broken"\n');
  const res = await run([file]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /frame error/);
});

test('truncated trailing frame exits 2', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(file, '{"idemKey":"a1","type":"auth","amount":200,"seq":1,"ts":1}');
  const res = await run([file]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /truncated/);
});

test('invalid message shape exits 2', async () => {
  const dir = tmpdir();
  const file = writeOps(dir, 'bad.jsonl', ['{"idemKey":"a1","type":"capture","amount":5,"seq":1,"ts":1}']);
  const res = await run([file]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /frame error/);
});

test('state conflict exits 3 with rejection in certificate', async () => {
  const dir = tmpdir();
  const file = writeOps(dir, 'conflict.jsonl', [
    '{"idemKey":"a1","type":"auth","amount":300,"seq":1,"ts":100,"ttl":50}',
    '{"idemKey":"c1","type":"capture","ref":"a1","amount":300,"seq":2,"ts":200}',
  ]);
  const res = await run([file]);
  assert.equal(res.code, 3, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.certificate.rejected, [{ idemKey: 'c1', reason: 'auth-void' }]);
  assert.equal(report.ledger[1].type, 'auto_void');
  assert.equal(report.available, 1000);
});

test('stdin input works with -', async () => {
  const res = await run(['-'], { stdin: '{"idemKey":"a1","type":"auth","amount":10,"seq":1,"ts":1}\n' });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).available, 990);
});

test('usage error exits 2', async () => {
  const res = await run([]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage:/);
});

test('crash-after then restart from WAL reproduces the clean run', async () => {
  const dir = tmpdir();
  const file = writeOps(dir, 'ops.jsonl', [
    '{"idemKey":"a1","type":"auth","amount":200,"seq":1,"ts":1}',
    '{"idemKey":"c1","type":"capture","ref":"a1","amount":120,"seq":2,"ts":2}',
    '{"idemKey":"r1","type":"refund","ref":"c1","amount":20,"seq":3,"ts":3}',
    '{"idemKey":"x1","type":"reversal","ref":"c1","amount":100,"seq":4,"ts":4}',
  ]);
  const wal = path.join(dir, 'wal.jsonl');

  const crash = await run([file, '--wal=' + wal, '--fresh', '--crash-after=3']);
  assert.equal(crash.code, 1);
  assert.equal(crash.stdout, '');

  const recovered = await run([file, '--wal=' + wal]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const clean = await run([file]);
  assert.equal(clean.code, 0, clean.stderr);

  const a = JSON.parse(recovered.stdout);
  const b = JSON.parse(clean.stdout);
  assert.equal(a.available, b.available);
  assert.deepEqual(a.ledger, b.ledger);
  // first three replies after recovery are duplicates (no double effect)
  assert.ok(a.replies[0].duplicate && a.replies[1].duplicate && a.replies[2].duplicate);
  assert.equal(a.replies[3].duplicate, undefined);
});
