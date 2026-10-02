import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initLedger, appendEvents, snapshot, readTail, readState, verify, anchorInfo,
  emptyState, applyEvent,
} from '../src/ledger.js';
import { loadManifest, manifestPath, manifestTmpPath } from '../src/manifest.js';
import { HEADER_SIZE } from '../src/format.js';
import { AuditError } from '../src/errors.js';

import { runCli } from '../src/cli.js';

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  return path.join(dir, name);
}

const STREAM = [
  { type: 'limit', account: 'a1', limit: 1000 },
  { type: 'pay', id: 'p1', account: 'a1', amount: 100 },
  { type: 'pay', id: 'p2', account: 'a1', amount: 250 },
  { type: 'limit', account: 'a2', limit: 500 },
  { type: 'pay', id: 'p3', account: 'a2', amount: 500 },
  { type: 'cancel', paymentId: 'p1' },
  { type: 'limit', account: 'a1', limit: 400 },
  { type: 'pay', id: 'p4', account: 'a1', amount: 50 },
  { type: 'cancel', paymentId: 'p3' },
  { type: 'pay', id: 'p5', account: 'a2', amount: 120 },
];

test('tail decode matches full enumeration across manifest windows', () => {
  // Ground truth: in-memory full enumeration of the event stream.
  const expectedState = emptyState();
  STREAM.forEach((event, i) => applyEvent(expectedState, event, i + 1));
  const allEvents = STREAM.map((event, i) => ({ seq: i + 1, ...event }));
  const anchorSeq = 4; // snapshot taken after the 4th event

  for (const window of [1, 2, 3, 16]) {
    const file = tmpFile(`w${window}.audit`);
    initLedger(file, window);
    appendEvents(file, STREAM.slice(0, 3));
    appendEvents(file, STREAM.slice(3, 4));
    snapshot(file);
    appendEvents(file, STREAM.slice(4, 7));
    appendEvents(file, STREAM.slice(7));

    // Full decode from anchor equals full enumeration.
    assert.deepEqual(readState(file), expectedState, `state mismatch for window=${window}`);
    assert.deepEqual(verify(file).lastSeq, STREAM.length);

    // Tail decode for varying n, including ranges beyond manifest coverage.
    for (const n of [1, 3, 5, 100]) {
      const tail = readTail(file, n);
      const fromSeq = Math.max(anchorSeq + 1, STREAM.length - n + 1);
      assert.deepEqual(tail.events, allEvents.slice(fromSeq - 1), `tail mismatch window=${window} n=${n}`);
      assert.equal(tail.fromSeq, fromSeq);
      assert.equal(tail.toSeq, STREAM.length);
    }
    // n larger than the manifest window must fall back to the anchor chain.
    const wide = readTail(file, STREAM.length);
    if (window === 1) assert.equal(wide.source, 'anchor-chain');
    const narrow = readTail(file, 1);
    assert.equal(narrow.source, 'manifest');
  }
});

test('business rule violations: unknown cancel, duplicate cancel, negative available', () => {
  const file = tmpFile('rules.audit');
  initLedger(file, 4);
  appendEvents(file, [{ type: 'limit', account: 'a1', limit: 500 }]);

  // Cancel of an unknown payment is rejected with code + range.
  assert.throws(
    () => appendEvents(file, [{ type: 'cancel', paymentId: 'nope' }]),
    (err) => err instanceof AuditError && err.code === 'UNKNOWN_PAYMENT' && Array.isArray(err.range),
  );

  appendEvents(file, [{ type: 'pay', id: 'p1', account: 'a1', amount: 200 }]);
  appendEvents(file, [{ type: 'cancel', paymentId: 'p1' }]);
  // A cancelled payment cannot be cancelled again.
  assert.throws(
    () => appendEvents(file, [{ type: 'cancel', paymentId: 'p1' }]),
    (err) => err.code === 'ALREADY_CANCELLED',
  );

  appendEvents(file, [{ type: 'pay', id: 'p2', account: 'a1', amount: 300 }]);
  // Limit reduction that would make available credit negative is rejected.
  assert.throws(
    () => appendEvents(file, [{ type: 'limit', account: 'a1', limit: 299 }]),
    (err) => err.code === 'NEGATIVE_AVAILABLE',
  );
  // Boundary: limit exactly equal to used credit is allowed (available = 0).
  appendEvents(file, [{ type: 'limit', account: 'a1', limit: 300 }]);
  assert.equal(readState(file).accounts.a1.limit, 300);
  // ...and any further payment then exceeds available credit.
  assert.throws(
    () => appendEvents(file, [{ type: 'pay', id: 'p3', account: 'a1', amount: 1 }]),
    (err) => err.code === 'INSUFFICIENT_FUNDS',
  );

  // CLI surfaces JSON errors with code and range on stderr, exit code 1.
  const res = runCli(['cancel', file, 'ghost']);
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stderr);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'UNKNOWN_PAYMENT');
  assert.ok(Array.isArray(out.error.range));
});

test('manifest crash recovery and CRC corruption: anchor prefix readable, tail fails', () => {
  const file = tmpFile('crash.audit');
  initLedger(file, 4);
  appendEvents(file, STREAM.slice(0, 3));
  appendEvents(file, STREAM.slice(3, 5));
  snapshot(file);
  appendEvents(file, STREAM.slice(5, 8));
  appendEvents(file, STREAM.slice(8));

  const before = readTail(file, 3);

  // Simulate crash before manifest replace: staged tmp deleted, old manifest stays.
  fs.writeFileSync(manifestTmpPath(file), '{"staged":true');
  fs.rmSync(manifestTmpPath(file));
  assert.deepEqual(readTail(file, 3), before);

  // Stale staged tmp left behind: old manifest still wins and tmp is cleaned up.
  fs.writeFileSync(manifestTmpPath(file), '{"staged":true');
  assert.deepEqual(readTail(file, 3), before);
  assert.ok(!fs.existsSync(manifestTmpPath(file)));

  // Corrupt one byte inside the last delta block's payload (breaks its CRC).
  const manifest = loadManifest(manifestPath(file));
  const target = [...manifest.blocks].reverse().find((b) => b.kind === 'delta');
  const fd = fs.openSync(file, 'r+');
  const byte = Buffer.alloc(1);
  fs.readSync(fd, byte, 0, 1, target.offset + HEADER_SIZE);
  byte[0] ^= 0xff;
  fs.writeSync(fd, byte, 0, 1, target.offset + HEADER_SIZE);
  fs.closeSync(fd);

  // Anchor prefix remains readable.
  const anchor = anchorInfo(file);
  assert.equal(anchor.seq, 5);
  assert.deepEqual(verify(file, anchor.seq).lastSeq, 5);

  // Full verify and tail both fail with CRC_MISMATCH carrying the block range.
  assert.throws(
    () => verify(file),
    (err) => err.code === 'CRC_MISMATCH' && JSON.stringify(err.range) === JSON.stringify([target.seqStart, target.seqEnd]),
  );
  assert.throws(
    () => readTail(file, 3),
    (err) => err.code === 'CRC_MISMATCH' && JSON.stringify(err.range) === JSON.stringify([target.seqStart, target.seqEnd]),
  );

  // CLI emits the JSON error with code and range.
  const res = runCli(['tail', file, '--n', '3']);
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stderr);
  assert.equal(out.error.code, 'CRC_MISMATCH');
  assert.deepEqual(out.error.range, [target.seqStart, target.seqEnd]);
});

test('cli smoke: append/snapshot/tail/verify/anchor/cancel', () => {
  const file = tmpFile('cli.audit');
  assert.equal(JSON.parse(runCli(['init', file, '--window', '2']).stdout).ok, true);
  const append = JSON.parse(runCli(['append', file,
    '{"type":"limit","account":"a1","limit":100}',
    '{"type":"pay","id":"p1","account":"a1","amount":40}']).stdout);
  assert.deepEqual([append.seqStart, append.seqEnd], [1, 2]);
  assert.equal(JSON.parse(runCli(['cancel', file, 'p1']).stdout).ok, true);
  assert.equal(JSON.parse(runCli(['snapshot', file]).stdout).seq, 3);
  JSON.parse(runCli(['append', file, '{"type":"pay","id":"p2","account":"a1","amount":10}']).stdout);
  // events at or before the anchor are folded into the snapshot
  const tail = JSON.parse(runCli(['tail', file, '--n', '2']).stdout);
  assert.deepEqual(tail.events.map((e) => e.seq), [4]);
  assert.equal(JSON.parse(runCli(['verify', file]).stdout).lastSeq, 4);
  assert.equal(JSON.parse(runCli(['anchor', file]).stdout).seq, 3);
});
