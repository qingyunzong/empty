import test from 'node:test';
import assert from 'node:assert/strict';
import { mkLedger, runCli, ok, fail } from './helpers.js';

test('idempotent replay returns the original result without double deduction', () => {
  const dir = mkLedger();
  const first = ok(runCli(dir, ['freeze', '--amount', '60', '--key', 'k1', '--quota', '100']));
  assert.equal(first.replayed, false);
  assert.equal(first.result.ticketId, 'T000001');
  assert.equal(first.result.ticketSeq, 1);
  assert.equal(first.result.available, 40);

  // Same idempotency key, even with a different amount: original result.
  const replay = ok(runCli(dir, ['freeze', '--amount', '25', '--key', 'k1']));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);

  // Quota was not deducted twice: exactly 40 remains available.
  const second = ok(runCli(dir, ['freeze', '--amount', '40', '--key', 'k2']));
  assert.equal(second.result.available, 0);
  const over = fail(runCli(dir, ['freeze', '--amount', '1', '--key', 'k3']), 1);
  assert.equal(over.error.code, 'INSUFFICIENT_QUOTA');
});

test('over-capture, over-release and duplicate expire are rejected', () => {
  const dir = mkLedger();
  ok(runCli(dir, ['freeze', '--amount', '60', '--key', 'f1', '--quota', '1000']));

  const overCapture = fail(
    runCli(dir, ['capture', '--ticket', 'T000001', '--amount', '61', '--key', 'c0']),
    1,
  );
  assert.equal(overCapture.error.code, 'CAPTURE_EXCEEDS_FROZEN');

  const capture = ok(runCli(dir, ['capture', '--ticket', 'T000001', '--amount', '30', '--key', 'c1']));
  assert.equal(capture.result.remainingFrozen, 30);

  // Idempotent capture replay does not capture twice.
  const captureReplay = ok(
    runCli(dir, ['capture', '--ticket', 'T000001', '--amount', '30', '--key', 'c1']),
  );
  assert.equal(captureReplay.replayed, true);
  let ticket = ok(runCli(dir, ['ticket', '--ticket', 'T000001'])).result;
  assert.equal(ticket.captured, 30);
  assert.equal(ticket.frozen, 30);

  const overRelease = fail(
    runCli(dir, ['release', '--ticket', 'T000001', '--amount', '31', '--key', 'r0']),
    1,
  );
  assert.equal(overRelease.error.code, 'RELEASE_EXCEEDS_FROZEN');

  ok(runCli(dir, ['release', '--ticket', 'T000001', '--amount', '30', '--key', 'r1']));
  ticket = ok(runCli(dir, ['ticket', '--ticket', 'T000001'])).result;
  assert.equal(ticket.status, 'RELEASED');

  // Expire on a closed ticket is rejected.
  const lateExpire = fail(runCli(dir, ['expire', '--ticket', 'T000001', '--key', 'e1']), 1);
  assert.equal(lateExpire.error.code, 'TICKET_NOT_OPEN');

  // Duplicate expire: first succeeds, second (new key) is rejected,
  // replaying the original key returns the original result.
  ok(runCli(dir, ['freeze', '--amount', '10', '--key', 'f2']));
  const expire = ok(runCli(dir, ['expire', '--ticket', 'T000002', '--key', 'e2']));
  assert.equal(expire.result.released, 10);
  const dup = fail(runCli(dir, ['expire', '--ticket', 'T000002', '--key', 'e3']), 1);
  assert.equal(dup.error.code, 'TICKET_NOT_OPEN');
  const expireReplay = ok(runCli(dir, ['expire', '--ticket', 'T000002', '--key', 'e2']));
  assert.equal(expireReplay.replayed, true);
  assert.deepEqual(expireReplay.result, expire.result);
});

test('cancel: uncaptured freeze is revoked, partial capture triggers compensation', () => {
  const dir = mkLedger();
  ok(runCli(dir, ['freeze', '--amount', '20', '--key', 'f1', '--quota', '100']));

  // Uncaptured freeze: plain cancel, quota fully returned.
  const cancel = ok(runCli(dir, ['cancel', '--ticket', 'T000001', '--key', 'x1']));
  assert.equal(cancel.result.compensated, 0);
  assert.equal(cancel.result.released, 20);
  const full = ok(runCli(dir, ['freeze', '--amount', '100', '--key', 'f2']));
  assert.equal(full.result.available, 0);

  // Partially captured freeze: remaining is released via compensation.
  ok(runCli(dir, ['capture', '--ticket', 'T000002', '--amount', '30', '--key', 'c1']));
  const compensated = ok(runCli(dir, ['cancel', '--ticket', 'T000002', '--key', 'x2']));
  assert.equal(compensated.result.compensated, 70);
  const ticket = ok(runCli(dir, ['ticket', '--ticket', 'T000002'])).result;
  assert.equal(ticket.status, 'CANCELLED');
  assert.equal(ticket.captured, 30);
  assert.equal(ticket.compensated, 70);
  assert.equal(ticket.released, 70);
  assert.equal(ticket.frozen, 0);

  // Cancel on a closed ticket is rejected.
  const again = fail(runCli(dir, ['cancel', '--ticket', 'T000002', '--key', 'x3']), 1);
  assert.equal(again.error.code, 'TICKET_NOT_OPEN');
});
