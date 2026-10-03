import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRecord, verifyRecords, dedupeByHash } from '../src/index.js';
import { shuffle, mulberry32 } from './helpers.js';

function buildLog() {
  const records = [];
  const step = appendRecord(records, {
    type: 'step', site: 'S1', gen: 1,
    payload: { op: 'fill-start' },
  });
  records.push(step);
  const t1 = appendRecord(records, {
    type: 'tombstone', site: 'S1', gen: 1,
    payload: { target: step.hash, scope: 'full', reason: 'wrong lot entered' },
  });
  records.push(t1);
  return { records, step, t1 };
}

test('acceptance 2: tombstone masks target, higher-gen tombstone of tombstone unmasks it', () => {
  const { records, step, t1 } = buildLog();

  const first = verifyRecords(records);
  assert.equal(first.exitCode, 0);
  assert.equal(first.certificate.status, 'ok');
  assert.deepEqual(first.certificate.masked.map((m) => m.hash), [step.hash]);
  assert.equal(first.certificate.masked[0].by, t1.hash);
  assert.equal(first.certificate.masked[0].scope, 'full');

  // revoke the revocation with a higher generation tombstone
  const t2 = appendRecord(records, {
    type: 'tombstone', site: 'S1', gen: 2,
    payload: { target: t1.hash, scope: 'full', reason: 'revocation was a mistake' },
  });
  records.push(t2);

  const second = verifyRecords(records);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(second.certificate.masked.map((m) => m.hash), [t1.hash]);
  assert.equal(second.certificate.masked[0].by, t2.hash);
  // original step is effective again; only the revoked tombstone stays masked-but-auditable
  assert.equal(second.certificate.effective, records.length - 1);

  // boundary is deterministic under arbitrary merge order
  const rand = mulberry32(7);
  for (let i = 0; i < 20; i += 1) {
    const shuffled = shuffle(records, rand);
    const again = verifyRecords(dedupeByHash(shuffled));
    assert.deepEqual(again.certificate, second.certificate);
  }
});

test('same-gen competing tombstones resolve deterministically by hash', () => {
  const base = [];
  const step = appendRecord(base, { type: 'step', site: 'S1', gen: 1, payload: { op: 'x' } });
  base.push(step);
  const ta = appendRecord(base, {
    type: 'tombstone', site: 'S1', gen: 1,
    payload: { target: step.hash, scope: 'full', reason: 'a' },
  });
  base.push(ta);
  const tb = appendRecord(base, {
    type: 'tombstone', site: 'S1', gen: 1,
    payload: { target: ta.hash, scope: 'full', reason: 'b' },
  });
  const log = [step, ta, tb];
  const rand = mulberry32(99);
  let expected = null;
  for (let i = 0; i < 20; i += 1) {
    const { certificate } = verifyRecords(shuffle(log, rand));
    if (expected === null) expected = certificate;
    assert.deepEqual(certificate, expected);
  }
  assert.equal(expected.masked.length, 1);
  assert.equal(expected.masked[0].hash, ta.hash);
});
