'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

// The CLI is exercised in-process (the sandbox forbids spawning children);
// `node cli.js mon.jsonl` goes through the exact same run() entry point.
function runCli(inputLines, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-cli-'));
  const input = path.join(dir, 'mon.jsonl');
  fs.writeFileSync(input, `${inputLines.join('\n')}\n`);
  const stdout = [];
  const stderr = [];
  const status = run([input, ...extraArgs], {
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
  });
  return { status, out: stdout.map((l) => JSON.parse(l)), stderr: stderr.join('\n'), dir, input };
}

test('end-to-end: init, batches, checkpoint, crash, status', () => {
  const { status, out } = runCli([
    '{"type":"init","pattern":"arm fire"}',
    '{"type":"batch","events":[{"id":"e1","type":"arm"}]}',
    '{"type":"status"}',
    '{"type":"batch","events":[{"id":"e2","type":"fire"}]}',
    '{"type":"checkpoint"}',
    '{"type":"batch","events":[{"id":"e3","type":"reset"}]}',
    '{"type":"crash"}',
    '{"type":"status"}',
  ]);
  assert.equal(status, 0);
  assert.equal(out[1].state, 'UNKNOWN');
  assert.equal(out[2].state, 'UNKNOWN');
  assert.equal(out[3].state, 'VIOLATION');
  assert.equal(out[4].type, 'checkpoint');
  assert.equal(out[4].seq, 2);
  assert.equal(out[5].state, 'VIOLATION'); // violation survives backfill
  assert.equal(out[6].type, 'recovered');
  assert.equal(out[6].seq, 3); // last complete batch, WAL ahead of checkpoint
  assert.equal(out[6].state, 'VIOLATION'); // violation survives the crash
  assert.equal(out[7].state, 'VIOLATION');
  assert.equal(out[7].hash, out[6].hash);
  // Output schema: exactly these fields, no UNSAT certificate anywhere.
  for (const rec of out) {
    if (rec.type === 'status' || rec.type === 'batch') {
      assert.deepEqual(Object.keys(rec).sort(),
        ['ambiguous', 'hash', 'seq', 'state', 'type']);
      assert.ok(['VIOLATION', 'SAFE', 'UNKNOWN'].includes(rec.state));
    }
  }
});

test('CLI reports ambiguity for order-sensitive batches', () => {
  const { status, out } = runCli([
    '{"type":"init","pattern":"arm fire"}',
    '{"type":"batch","events":[{"id":"a1","type":"fire"},{"id":"a2","type":"arm"}]}',
    '{"type":"status"}',
  ]);
  assert.equal(status, 0);
  assert.equal(out[1].ambiguous, true);
  assert.equal(out[2].ambiguous, true); // sticky in status
});

test('duplicate id in a macro-step exits with code 12', () => {
  const { status, stderr } = runCli([
    '{"type":"init","pattern":"a b"}',
    '{"type":"batch","events":[{"id":"x","type":"a"},{"id":"x","type":"b"}]}',
  ]);
  assert.equal(status, 12);
  assert.match(stderr, /DUP_ID/);
});

test('hash mismatch in existing WAL exits with code 12', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-cli-'));
  const input = path.join(dir, 'mon.jsonl');
  fs.writeFileSync(input, '{"type":"init","pattern":"a b"}\n{"type":"batch","events":[{"id":"e1","type":"a"}]}\n');
  const io1 = { stdout: () => {}, stderr: () => {} };
  assert.equal(run([input], io1), 0);
  // Tamper with the WAL, then run again: startup recovery must reject it.
  const wal = `${input}.wal`;
  const rec = JSON.parse(fs.readFileSync(wal, 'utf8').trim());
  rec.events = [{ id: 'e1', type: 'b' }];
  fs.writeFileSync(wal, `${JSON.stringify(rec)}\n`);
  const stderr = [];
  const status = run([input], { stdout: () => {}, stderr: (l) => stderr.push(l) });
  assert.equal(status, 12);
  assert.match(stderr.join('\n'), /HASH_MISMATCH/);
});

test('missing input file exits with usage code 2', () => {
  const status = run(['/nonexistent/mon.jsonl'], { stdout: () => {}, stderr: () => {} });
  assert.equal(status, 2);
});

test('torn WAL tail from a crash mid-write is truncated on recovery', () => {
  const { status, out } = runCli([
    '{"type":"init","pattern":"arm fire"}',
    '{"type":"batch","events":[{"id":"e1","type":"arm"}]}',
    '{"type":"batch","events":[{"id":"e2","type":"reset"}]}',
    '{"type":"crash","torn":true}',
    '{"type":"status"}',
  ]);
  assert.equal(status, 0);
  assert.equal(out[3].type, 'recovered');
  assert.equal(out[3].seq, 2); // last complete batch
  assert.equal(out[4].seq, 2);
});
