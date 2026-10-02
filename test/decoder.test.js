import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog } from '../src/log.js';
import { Decoder } from '../src/decoder.js';
import { issueCertificate, verifyCertificate } from '../src/certificate.js';
import { tmpLogPath } from './helpers.js';

test('incremental decoder matches a full decode from scratch', () => {
  const file = tmpLogPath();
  const log = EventLog.open(file, { blockSize: 2 });
  log.append({ device: 'a', status: 0, payload: 'e1', ts: 100 });
  log.append({ device: 'a', status: 1, payload: 'e2', ts: 200 });
  log.close();

  const inc = new Decoder(file);
  inc.update();
  const viewAfterFirst = inc.view();

  const log2 = EventLog.open(file, { blockSize: 2 });
  log2.append({ device: 'b', status: 3, payload: 'e3', ts: 300 });
  log2.correct({ seq: 1, reason: 'recalibration', status: 9, ts: 400 });
  log2.close();

  inc.update(); // only decodes the new block
  const full = new Decoder(file).update();
  assert.deepEqual(inc.view(), full.view());
  assert.deepEqual(inc.history(), full.history());
  assert.notDeepEqual(inc.view(), viewAfterFirst);
});

test('out-of-order corrections change the view once backfilled, certificates re-verify', () => {
  const file = tmpLogPath();
  const log = EventLog.open(file, { blockSize: 4 });
  log.append({ device: 'pump-1', status: 0, payload: 'start', ts: 1000 });
  log.append({ device: 'pump-1', status: 1, payload: 'run', ts: 1600 });
  log.append({ device: 'valve-2', status: 0, payload: 'open', ts: 2000 });
  log.append({ device: 'valve-2', status: 0, payload: 'close', ts: 3100 });
  log.close();

  const decoder = new Decoder(file).update();
  const before = decoder.view();
  assert.equal(before.find((r) => r.seq === 3).status, 0);
  assert.equal(before.find((r) => r.seq === 1).status, 0);

  // Corrections arrive out of order relative to the events they target.
  const log2 = EventLog.open(file, { blockSize: 2 });
  log2.correct({ seq: 3, reason: 'late reading', status: 5, ts: 5000 });
  log2.correct({ seq: 1, reason: 'backfilled fix', status: 2, payload: 'restart', ts: 5100 });
  log2.close();

  decoder.update();
  const after = decoder.view();
  assert.deepEqual(after.find((r) => r.seq === 3), {
    seq: 3, ts: 2000, device: 'valve-2', status: 5, payload: 'open', corrected: true, correctedBy: 5,
  });
  assert.deepEqual(after.find((r) => r.seq === 1), {
    seq: 1, ts: 1000, device: 'pump-1', status: 2, payload: 'restart', corrected: true, correctedBy: 6,
  });
  // Untouched events stay identical.
  assert.deepEqual(after.find((r) => r.seq === 2), before.find((r) => r.seq === 2));

  // Certificates for both corrections verify against the updated log.
  const cert3 = issueCertificate(decoder, 3);
  const cert1 = issueCertificate(decoder, 1);
  assert.equal(cert3.targetSeq, 3);
  assert.equal(cert3.activeSeq, 5);
  assert.match(cert3.originalHash, /^[0-9a-f]{64}$/);
  assert.match(cert3.correctionHash, /^[0-9a-f]{64}$/);
  assert.equal(verifyCertificate(decoder, cert3), true);
  assert.equal(verifyCertificate(decoder, cert1), true);

  // A fresh decoder after "restart" re-verifies the same certificates.
  const fresh = new Decoder(file).update();
  assert.equal(verifyCertificate(fresh, cert3), true);
  assert.equal(verifyCertificate(fresh, cert1), true);

  // Tampered certificates are rejected.
  assert.equal(verifyCertificate(fresh, { ...cert3, correctionHash: cert1.correctionHash }), false);
  assert.equal(verifyCertificate(fresh, { ...cert3, activeSeq: 6 }), false);
});

test('a newer correction supersedes and the certificate tracks the active one', () => {
  const file = tmpLogPath();
  const log = EventLog.open(file, { blockSize: 2 });
  log.append({ device: 'pump-1', status: 0, ts: 1000 });
  log.correct({ seq: 1, reason: 'first fix', status: 3, ts: 2000 });
  log.correct({ seq: 1, reason: 'second fix', status: 4, ts: 3000 });
  log.close();

  const decoder = new Decoder(file).update();
  assert.equal(decoder.view()[0].status, 4);
  assert.equal(decoder.view()[0].correctedBy, 3);

  const cert = issueCertificate(decoder, 1);
  assert.equal(cert.activeSeq, 3);
  assert.equal(verifyCertificate(decoder, cert), true);

  // A certificate naming the superseded correction is no longer valid.
  assert.equal(verifyCertificate(decoder, { ...cert, activeSeq: 2 }), false);
});
