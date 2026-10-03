import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRecord, verifyRecords, makeRecord, EXIT_BROKEN_CHAIN, EXIT_LOW_GEN_BACKFILL } from '../src/index.js';
import { siteLog } from './helpers.js';

test('tampered payload breaks the chain: exit 15', () => {
  const log = siteLog('S1', 1, 3);
  log[1] = { ...log[1], payload: { op: 'tampered' } };
  const { exitCode, certificate } = verifyRecords(log);
  assert.equal(exitCode, EXIT_BROKEN_CHAIN);
  assert.equal(certificate.status, 'broken');
});

test('forked site chain (same counter, different hash): exit 15', () => {
  const first = siteLog('S1', 1, 2);
  const alt = appendRecord([first[0]], { type: 'step', site: 'S1', gen: 1, payload: { op: 'fork' } });
  const { exitCode } = verifyRecords([...first, alt]);
  assert.equal(exitCode, EXIT_BROKEN_CHAIN);
});

test('gen decreasing along a site chain: exit 15', () => {
  const log = siteLog('S1', 2, 2);
  const lowered = appendRecord(log, { type: 'step', site: 'S1', gen: 1, payload: { op: 'late' } });
  const { exitCode } = verifyRecords([...log, lowered]);
  assert.equal(exitCode, EXIT_BROKEN_CHAIN);
});

test('low-generation backfill after site exit: exit 16, history preserved', () => {
  const log = siteLog('S1', 1, 2);
  const exit = appendRecord(log, { type: 'exit', site: 'S1', gen: 2, payload: {} });
  assert.deepEqual(exit.payload.seal, { count: 2, head: log[1].hash });
  const withExit = [...log, exit];

  // legitimate history still verifies
  const ok = verifyRecords(withExit);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.certificate.status, 'ok');

  // backfill stamped with the old generation, beyond the seal
  const backfill = appendRecord(withExit, { type: 'step', site: 'S1', gen: 1, payload: { op: 'sneaky' } });
  const rejected = verifyRecords([...withExit, backfill]);
  assert.equal(rejected.exitCode, EXIT_LOW_GEN_BACKFILL);
  assert.equal(rejected.certificate.status, 'rejected');
  assert.match(rejected.certificate.error, /backfill/);

  // rejoin at a higher generation is allowed and history is kept
  const rejoined = appendRecord(withExit, { type: 'step', site: 'S1', gen: 3, payload: { op: 'resumed' } });
  const resumed = verifyRecords([...withExit, rejoined]);
  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.certificate.records, 4);
});

test('exit seal head mismatch: exit 15', () => {
  const log = siteLog('S1', 1, 2);
  const exit = appendRecord(log, { type: 'exit', site: 'S1', gen: 2, payload: {} });
  const forged = { ...exit, payload: { seal: { count: 2, head: log[0].hash } } };
  // recompute hash so only the seal content is wrong, not the record integrity
  const { exitCode } = verifyRecords([...log, rehash(forged)]);
  assert.equal(exitCode, EXIT_BROKEN_CHAIN);
});

function rehash(record) {
  return makeRecord({
    type: record.type, site: record.site, gen: record.gen,
    vc: record.vc, prev: record.prev, payload: record.payload,
  });
}
