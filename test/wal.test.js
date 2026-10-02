'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Core } = require('../src/core');
const { Wal } = require('../src/wal');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wal-test-'));
}

const FRAMES = [
  { seq: 0, t: 0, op: { op: 'refund', key: 'k1', order: 'o1', amount: 40, riskTag: 'high', paid: 100 } },
  { seq: 1, t: 10, op: { op: 'approve', key: 'k1' } },
  { seq: 2, t: 20, op: { op: 'refund', key: 'k2', order: 'o1', amount: 30, riskTag: 'high', paid: 100 } },
  { seq: 3, t: 30, op: { op: 'reverse', key: 'k1' } },
];

function runToWal(walPath, frames) {
  const wal = new Wal(walPath);
  wal.open();
  const core = new Core({ budgetLimit: 50, slaMs: 100, highRiskTags: ['high'] });
  core.setHasher(sha256);
  for (const f of frames) {
    const result = core.apply(f.op, f.t);
    wal.append({ kind: 'frame', seq: f.seq, t: f.t, op: f.op, result });
  }
  wal.close();
  return core;
}

function replay(walPath) {
  const wal = new Wal(walPath);
  const { records, truncatedBytes } = wal.open();
  const core = new Core({ budgetLimit: 50, slaMs: 100, highRiskTags: ['high'] });
  core.setHasher(sha256);
  for (const rec of records) {
    if (rec.kind === 'frame') core.apply(rec.op, rec.t);
  }
  wal.close();
  return { core, truncatedBytes, records };
}

test('replay after crash rebuilds identical state without double deduction', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'a.wal');
  const live = runToWal(walPath, FRAMES);
  const { core: restored, truncatedBytes } = replay(walPath);
  assert.equal(truncatedBytes, 0);
  assert.deepEqual(restored.snapshot(), live.snapshot());
  assert.equal(restored.orders.get('o1').refunded, 0, 'approve+reverse net to zero, not doubled');
  assert.equal(restored.budgetUsed, 30, 'only k2 budget remains held');
});

test('torn tail (crash mid-write) is truncated and replayed cleanly', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'b.wal');
  const live = runToWal(walPath, FRAMES);
  // Simulate a crash while writing the next record: garbage tail.
  fs.appendFileSync(walPath, Buffer.from([0, 0, 12, 34, 255]));
  const { core: restored, truncatedBytes } = replay(walPath);
  assert.equal(truncatedBytes, 5);
  assert.deepEqual(restored.snapshot(), live.snapshot());
  // The WAL stays writable after recovery.
  const wal = new Wal(walPath);
  wal.open();
  wal.append({ kind: 'frame', seq: 4, t: 40, op: { op: 'approve', key: 'k2' }, result: {} });
  wal.close();
  const again = replay(walPath);
  assert.equal(again.records.length, 5);
});

test('corrupt payload (bit flip) is detected via checksum and truncated', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'c.wal');
  runToWal(walPath, FRAMES.slice(0, 2));
  const buf = fs.readFileSync(walPath);
  buf[buf.length - 6] ^= 0xff; // flip a bit inside the last record payload
  fs.writeFileSync(walPath, buf);
  const { records, truncatedBytes } = replay(walPath);
  assert.equal(records.length, 1, 'only the intact first record survives');
  assert.ok(truncatedBytes > 0);
});

test('failure point matrix: before decision / after log / before response', () => {
  const dir = tmpdir();

  // (1) crash BEFORE decision: nothing logged, nothing applied.
  const wal1 = path.join(dir, 'd1.wal');
  runToWal(wal1, FRAMES.slice(0, 1));
  const r1 = replay(wal1);
  assert.equal(r1.core.refunds.size, 1);
  assert.equal(r1.core.refunds.get('k1').state, 'PENDING');

  // (2) crash AFTER log, BEFORE response: frame is in the WAL; replay applies
  //     it exactly once and the stored result can be re-served to the client.
  const wal2 = path.join(dir, 'd2.wal');
  runToWal(wal2, FRAMES.slice(0, 2));
  const r2 = replay(wal2);
  assert.equal(r2.core.refunds.get('k1').state, 'APPROVED');
  assert.equal(r2.core.orders.get('o1').refunded, 40, 'deducted exactly once');
  const lastFrame = r2.records[r2.records.length - 1];
  assert.deepEqual(lastFrame.result, { status: 'ok', key: 'k1', state: 'APPROVED' });

  // (3) full run + restart + replay of the SAME frames is idempotent.
  const wal3 = path.join(dir, 'd3.wal');
  const live = runToWal(wal3, FRAMES);
  const r3 = replay(wal3);
  assert.equal(r3.core.auditHash(), live.auditHash(), 'identical audit chain after replay');
});
