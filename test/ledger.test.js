'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const { HEADER_SIZE } = require('../src/ledger');
const { stateRoot } = require('../src/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-'));
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function ok(args) {
  const r = run(args);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function rejected(args) {
  const r = run(args);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
  assert.equal(JSON.parse(r.stderr).code, 'REJECTED');
  return r;
}

// Reference model: folds the full op array from scratch, independently of the
// ledger implementation, and mirrors the store's state shape.
function computeState(total, ops) {
  const s = {
    total,
    available: total,
    capturedTotal: 0,
    tickets: {},
    captures: {},
    ticketSeq: 0,
    captureSeq: 0,
  };
  for (const op of ops) {
    if (op.op === 'freeze') {
      s.ticketSeq += 1;
      const id = `T${s.ticketSeq}`;
      s.tickets[id] = { id, amount: op.amount, remaining: op.amount, status: 'open' };
      s.available -= op.amount;
    } else if (op.op === 'capture') {
      s.captureSeq += 1;
      const id = `C${s.captureSeq}`;
      s.captures[id] = { id, ticketId: op.ticketId, amount: op.amount, undone: false };
      s.tickets[op.ticketId].remaining -= op.amount;
      s.total -= op.amount;
      s.capturedTotal += op.amount;
    } else if (op.op === 'release') {
      const t = s.tickets[op.ticketId];
      s.available += t.remaining;
      t.remaining = 0;
      t.status = 'released';
    } else if (op.op === 'undo') {
      const c = s.captures[op.captureId];
      c.undone = true;
      s.total += c.amount;
      s.capturedTotal -= c.amount;
      const t = s.tickets[c.ticketId];
      if (t && t.status === 'open') t.remaining += c.amount;
      else s.available += c.amount;
    }
  }
  return s;
}

const TEN_OPS = [
  { args: ['freeze', '--amount', '100'], op: { op: 'freeze', amount: 100 } },
  { args: ['freeze', '--amount', '200'], op: { op: 'freeze', amount: 200 } },
  { args: ['capture', '--ticket', 'T1', '--amount', '40'], op: { op: 'capture', ticketId: 'T1', amount: 40 } },
  { args: ['capture', '--ticket', 'T1', '--amount', '30'], op: { op: 'capture', ticketId: 'T1', amount: 30 } },
  { args: ['undo', '--capture', 'C1'], op: { op: 'undo', captureId: 'C1' } },
  { args: ['release', '--ticket', 'T1'], op: { op: 'release', ticketId: 'T1' } },
  { args: ['capture', '--ticket', 'T2', '--amount', '150'], op: { op: 'capture', ticketId: 'T2', amount: 150 } },
  { args: ['freeze', '--amount', '500'], op: { op: 'freeze', amount: 500 } },
  { args: ['release', '--ticket', 'T3'], op: { op: 'release', ticketId: 'T3' } },
  { args: ['capture', '--ticket', 'T2', '--amount', '50'], op: { op: 'capture', ticketId: 'T2', amount: 50 } },
];

test('10 ticket ops: every version restores to the reference full-array state', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'l.db');
  ok(['init', '--file', file, '--total', '1000']);

  const ops = [];
  for (let i = 0; i < TEN_OPS.length; i += 1) {
    const { args, op } = TEN_OPS[i];
    const out = ok([...args, '--file', file]);
    assert.equal(out.version, i + 1);
    ops.push(op);

    // Compare every version so far against the reference model.
    for (let v = 0; v <= i + 1; v += 1) {
      const restored = ok(['restore', '--file', file, '--version', String(v)]);
      const expected = computeState(1000, ops.slice(0, v));
      assert.deepEqual(restored.state, expected, `state mismatch at version ${v}`);
      assert.equal(restored.certificate.version, v);
      assert.equal(restored.certificate.stateRoot, stateRoot(expected));
    }

    // Quota invariant: available + frozen remaining == total (captures
    // already left the total; undo/release keep the sum unchanged).
    const s = out.state;
    const frozen = Object.values(s.tickets).reduce((a, t) => a + t.remaining, 0);
    assert.equal(s.available + frozen, s.total);
  }

  const verified = ok(['verify', '--file', file]);
  assert.equal(verified.version, TEN_OPS.length);
  assert.deepEqual(verified.state, computeState(1000, ops));
});

test('repeated release, over-capture and undo of unknown capture are rejected', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'l.db');
  ok(['init', '--file', file, '--total', '1000']);
  ok(['freeze', '--file', file, '--amount', '100']);
  ok(['release', '--file', file, '--ticket', 'T1']);
  rejected(['release', '--file', file, '--ticket', 'T1']); // repeated release
  rejected(['release', '--file', file, '--ticket', 'T99']); // unknown ticket

  ok(['freeze', '--file', file, '--amount', '50']);
  ok(['capture', '--file', file, '--ticket', 'T2', '--amount', '30']);
  rejected(['capture', '--file', file, '--ticket', 'T2', '--amount', '25']); // over-capture (20 left)
  rejected(['capture', '--file', file, '--ticket', 'T77', '--amount', '1']); // unknown ticket

  rejected(['undo', '--file', file, '--capture', 'C999']); // unknown capture
  ok(['undo', '--file', file, '--capture', 'C1']);
  rejected(['undo', '--file', file, '--capture', 'C1']); // already undone

  // Rejections must not have appended anything: only 5 successful ops.
  const verified = ok(['verify', '--file', file]);
  assert.equal(verified.version, 5);
});

test('corrupt middle delta: older versions recover, newer fail with CORRUPT', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'l.db');
  ok(['init', '--file', file, '--total', '1000']);
  const ops = [];
  for (const { args, op } of TEN_OPS.slice(0, 6)) {
    ok([...args, '--file', file]);
    ops.push(op);
  }

  // Corrupt the payload of delta version 5 (a snapshot exists at version 4).
  const index = JSON.parse(fs.readFileSync(`${file}.index.json`, 'utf8'));
  const badVersion = 5;
  const offset = index.versions[String(badVersion)];
  assert.notEqual(offset, undefined);
  const fd = fs.openSync(file, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, offset + HEADER_SIZE);
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, offset + HEADER_SIZE);
  fs.closeSync(fd);

  // Versions strictly before the corrupt block remain fully recoverable.
  for (let v = 0; v < badVersion; v += 1) {
    const restored = ok(['restore', '--file', file, '--version', String(v)]);
    assert.deepEqual(restored.state, computeState(1000, ops.slice(0, v)));
  }

  // Versions at or after the corrupt block fail with code=CORRUPT, exit 2,
  // and no half-merged state on stdout.
  for (const v of [badVersion, badVersion + 1]) {
    const r = run(['restore', '--file', file, '--version', String(v)]);
    assert.equal(r.status, 2, `expected exit 2 for version ${v}, got ${r.status}`);
    assert.equal(JSON.parse(r.stderr).code, 'CORRUPT');
    assert.equal(r.stdout, '');
  }

  // Mutations on a corrupt chain are refused as corrupt, not half-applied.
  const m = run(['freeze', '--file', file, '--amount', '1']);
  assert.equal(m.status, 2);
  assert.equal(JSON.parse(m.stderr).code, 'CORRUPT');

  // verify decodes all blocks and reports the corruption.
  const v = run(['verify', '--file', file]);
  assert.equal(v.status, 2);
  assert.equal(JSON.parse(v.stderr).code, 'CORRUPT');
});
