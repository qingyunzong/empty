import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../testkit/helpers.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fzidem-'));
}

test('idempotency-key replay returns original result without double deduction', () => {
  const dir = tmpdir();
  const a = runCli(['freeze', '--amount', '100', '--idempotency-key', 'K1'], { dir, limit: 1000 });
  assert.equal(a.status, 0);
  assert.equal(a.json.ticketId, 'T-000001');
  const b = runCli(['freeze', '--amount', '100', '--idempotency-key', 'K1'], { dir, limit: 1000 });
  assert.equal(b.status, 0);
  assert.equal(b.json.replayed, true);
  assert.equal(b.json.ticketId, 'T-000001');
  assert.equal(b.json.serial, a.json.serial);
  // A new key creates the next ticket, proving the replay did not deduct again.
  const c = runCli(['freeze', '--amount', '100', '--idempotency-key', 'K2'], { dir, limit: 1000 });
  assert.equal(c.json.ticketId, 'T-000002');

  const cap = runCli(['capture', '--ticket', 'T-000001', '--amount', '40', '--idempotency-key', 'C1'], { dir });
  assert.equal(cap.status, 0);
  assert.equal(cap.json.remaining, 60);
  const capReplay = runCli(['capture', '--ticket', 'T-000001', '--amount', '40', '--idempotency-key', 'C1'], { dir });
  assert.equal(capReplay.status, 0);
  assert.equal(capReplay.json.replayed, true);
  assert.equal(capReplay.json.remaining, 60);
  const t = runCli(['ticket', '--ticket', 'T-000001'], { dir });
  assert.equal(t.json.ticket.captured, 40, 'replayed capture must not deduct twice');
});

test('idempotency key reused with different command or args is rejected', () => {
  const dir = tmpdir();
  runCli(['freeze', '--amount', '100', '--idempotency-key', 'K1'], { dir });
  const diffCmd = runCli(['capture', '--ticket', 'T-000001', '--amount', '10', '--idempotency-key', 'K1'], { dir });
  assert.equal(diffCmd.status, 1);
  const diffArgs = runCli(['freeze', '--amount', '200', '--idempotency-key', 'K1'], { dir });
  assert.equal(diffArgs.status, 1);
});

test('over-capture and over-release are rejected with exit code 1', () => {
  const dir = tmpdir();
  runCli(['freeze', '--amount', '100', '--idempotency-key', 'K1'], { dir });
  const overCap = runCli(['capture', '--ticket', 'T-000001', '--amount', '101'], { dir });
  assert.equal(overCap.status, 1);
  assert.match(overCap.stderr, /capture exceeds remaining frozen/);
  const overRel = runCli(['release', '--ticket', 'T-000001', '--amount', '101'], { dir });
  assert.equal(overRel.status, 1);
  assert.match(overRel.stderr, /release exceeds remaining frozen/);
  runCli(['capture', '--ticket', 'T-000001', '--amount', '100'], { dir });
  const capAfterFull = runCli(['capture', '--ticket', 'T-000001', '--amount', '1'], { dir });
  assert.equal(capAfterFull.status, 1);
});

test('insufficient total credit is rejected', () => {
  const dir = tmpdir();
  const ok = runCli(['freeze', '--amount', '100'], { dir, limit: 150 });
  assert.equal(ok.status, 0);
  const denied = runCli(['freeze', '--amount', '100'], { dir, limit: 150 });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /insufficient total credit/);
  runCli(['capture', '--ticket', 'T-000001', '--amount', '50'], { dir });
  const okAgain = runCli(['freeze', '--amount', '100'], { dir, limit: 150 });
  assert.equal(okAgain.status, 0, 'captured credit frees room for a new freeze');
});

test('duplicate expire is rejected; replayed expire key returns original result', () => {
  const dir = tmpdir();
  runCli(['freeze', '--amount', '100', '--idempotency-key', 'K1'], { dir });
  runCli(['capture', '--ticket', 'T-000001', '--amount', '30', '--idempotency-key', 'C1'], { dir });
  const exp = runCli(['expire', '--ticket', 'T-000001', '--idempotency-key', 'E1'], { dir });
  assert.equal(exp.status, 0);
  assert.equal(exp.json.status, 'expired');
  assert.equal(exp.json.released, 70);
  const dup = runCli(['expire', '--ticket', 'T-000001', '--idempotency-key', 'E2'], { dir });
  assert.equal(dup.status, 1, 'duplicate expire with a new key must be rejected');
  const replay = runCli(['expire', '--ticket', 'T-000001', '--idempotency-key', 'E1'], { dir });
  assert.equal(replay.status, 0);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.released, 70);
  const t = runCli(['ticket', '--ticket', 'T-000001'], { dir });
  assert.equal(t.json.ticket.released, 70, 'replayed expire must not release twice');
});

test('cancel rules: uncaptured cancelled, partially captured compensated', () => {
  const dir = tmpdir();
  runCli(['freeze', '--amount', '100', '--idempotency-key', 'K1'], { dir });
  runCli(['freeze', '--amount', '100', '--idempotency-key', 'K2'], { dir });
  runCli(['capture', '--ticket', 'T-000002', '--amount', '25', '--idempotency-key', 'C2'], { dir });

  const cancel = runCli(['cancel', '--ticket', 'T-000001', '--idempotency-key', 'X1'], { dir });
  assert.equal(cancel.status, 0);
  assert.equal(cancel.json.status, 'cancelled');
  assert.equal(cancel.json.released, 100);

  const comp = runCli(['cancel', '--ticket', 'T-000002', '--idempotency-key', 'X2'], { dir });
  assert.equal(comp.status, 0);
  assert.equal(comp.json.status, 'compensated');
  assert.equal(comp.json.released, 75, 'remaining frozen released by compensation');
  assert.equal(comp.json.captured, 25);

  const again = runCli(['cancel', '--ticket', 'T-000001', '--idempotency-key', 'X3'], { dir });
  assert.equal(again.status, 1, 'cancel of a closed ticket is rejected');

  const t = runCli(['ticket', '--ticket', 'T-000002'], { dir });
  assert.equal(t.json.ticket.status, 'compensated');
});
