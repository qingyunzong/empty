import test from 'node:test';
import assert from 'node:assert/strict';
import { Certifier } from '../src/certify.js';

const OPTS = { windowMs: 500, watermarkLagMs: 1000, angleMin: 0, angleMax: 720 };

const calib = (id, eventTs, tool, validFrom, validTo, ok = true) => ({
  kind: 'calib', id, eventTs, tool, ok, validFrom, validTo, op: null,
});
const torque = (id, eventTs, bolt, tool, angle, peak = 10) => ({
  kind: 'torque', id, eventTs, bolt, tool, peak, angle, op: null,
});
const scan = (id, eventTs, bolt, lot) => ({ kind: 'scan', id, eventTs, bolt, lot, op: null });
const retract = (eventTs, targetKind, targetId) => ({
  kind: 'retract', id: `retract#${targetKind}#${targetId}`, eventTs, targetKind, targetId,
});

function statuses(certifier, bolt) {
  return certifier.emissions
    .filter((e) => e.record.bolt === bolt)
    .map((e) => ({ stream: e.stream, status: e.record.status, version: e.record.version, reasons: e.record.reasons }));
}

test('acceptance 1: calib retract cascades OK -> VOID for every bolt on the tool', () => {
  const c = new Certifier(OPTS);
  c.ingest(calib('c1', 1000, 'T1', 0, 30000));
  c.ingest(torque('t1', 10000, 'B1', 'T1', 90));
  c.ingest(scan('s1', 10200, 'B1', 'L1'));
  c.ingest(torque('t2', 11000, 'B2', 'T1', 95));
  c.ingest(scan('s2', 11100, 'B2', 'L2'));

  assert.equal(c.finalCerts().get('B1').status, 'OK');
  assert.equal(c.finalCerts().get('B2').status, 'OK');

  c.ingest(retract(20000, 'calib', 'c1'));

  const b1 = c.finalCerts().get('B1');
  const b2 = c.finalCerts().get('B2');
  assert.equal(b1.status, 'VOID');
  assert.deepEqual(b1.reasons, ['CALIB_RETRACTED']);
  assert.equal(b2.status, 'VOID');

  const voids = c.emissions.filter((e) => e.stream === 'void').map((e) => e.record);
  assert.equal(voids.length, 2);
  assert.deepEqual(voids.map((v) => v.bolt).sort(), ['B1', 'B2']);
  assert.ok(voids.every((v) => v.reasons.includes('CALIB_RETRACTED')));
});

test('acceptance 2: late scan turns HOLD into OK and is logged late', () => {
  const c = new Certifier(OPTS);
  c.ingest(calib('c1', 1000, 'T1', 0, 40000));
  c.ingest(torque('t1', 10000, 'B1', 'T1', 90));
  assert.equal(c.finalCerts().get('B1').status, 'HOLD');
  assert.deepEqual(c.finalCerts().get('B1').reasons, ['MISSING_LOT']);

  // Push the watermark far beyond the scan's eventTs.
  c.ingest(torque('t9', 30000, 'B9', 'T1', 80));
  c.ingest(scan('s9', 30000, 'B9', 'L9'));

  const res = c.ingest(scan('s1', 10300, 'B1', 'L1'));
  assert.equal(res.late, true);

  const final = c.finalCerts().get('B1');
  assert.equal(final.status, 'OK');
  assert.equal(final.lot, 'L1');

  assert.deepEqual(
    statuses(c, 'B1').map((s) => s.status),
    ['HOLD', 'OK'],
  );
  assert.equal(c.late.length, 1);
  assert.equal(c.late[0].id, 's1');
  assert.equal(c.late[0].reason, 'LATE_EVENT');
  assert.ok(c.late[0].eventTs < c.late[0].watermark);
});

test('retract recovery keeps every old certificate version', () => {
  const c = new Certifier(OPTS);
  c.ingest(calib('c1', 1000, 'T1', 0, 30000));
  c.ingest(torque('t1', 10000, 'B1', 'T1', 90));
  c.ingest(scan('s1', 10200, 'B1', 'L1'));
  c.ingest(retract(20000, 'calib', 'c1'));
  c.ingest(calib('c2', 21000, 'T1', 5000, 25000));

  const history = statuses(c, 'B1');
  assert.deepEqual(
    history.map((h) => [h.version, h.stream, h.status]),
    [
      [1, 'certs', 'HOLD'],
      [2, 'certs', 'OK'],
      [3, 'void', 'VOID'],
      [4, 'certs', 'OK'],
    ],
  );
  const final = c.finalCerts().get('B1');
  assert.equal(final.calibId, 'c2');
  assert.equal(final.version, 4);
  // Old versions are still present in the append-only streams.
  assert.ok(c.emissions.some((e) => e.record.version === 3 && e.record.status === 'VOID'));
});

test('only the last non-retracted angle-qualified tightening counts; ties break by eventTs then id', () => {
  const c = new Certifier(OPTS);
  c.ingest(calib('c1', 1000, 'T1', 0, 30000));
  c.ingest(torque('t1', 10000, 'B1', 'T1', 90, 10));
  c.ingest(torque('t2', 10000, 'B1', 'T1', 91, 20)); // same eventTs, higher id wins
  c.ingest(scan('s1', 10200, 'B1', 'L1'));
  assert.equal(c.finalCerts().get('B1').torqueId, 't2');

  c.ingest(torque('t3', 12000, 'B1', 'T1', 9999, 30)); // angle out of range: ignored
  assert.equal(c.finalCerts().get('B1').torqueId, 't2');
  assert.equal(c.reports.length, 1);
  assert.equal(c.reports[0].code, 'ANGLE_RANGE');

  c.ingest(retract(13000, 'torque', 't2')); // retract winner: t1 takes over
  const final = c.finalCerts().get('B1');
  assert.equal(final.torqueId, 't1');
  assert.equal(final.status, 'OK');
});

test('acceptance 4: conflicting duplicate id raises DUP_EVENT, identical resend is idempotent', () => {
  const c = new Certifier(OPTS);
  const event = torque('t1', 10000, 'B1', 'T1', 90);
  const first = c.ingest(event);
  assert.equal(first.duplicate, false);
  const again = c.ingest({ ...event });
  assert.equal(again.duplicate, true);
  assert.throws(
    () => c.ingest(torque('t1', 10000, 'B1', 'T1', 91)),
    (err) => err.code === 'DUP_EVENT',
  );
});

test('missing calibration yields HOLD with NO_CALIB, not an error', () => {
  const c = new Certifier(OPTS);
  c.ingest(torque('t1', 10000, 'B1', 'T1', 90));
  c.ingest(scan('s1', 10200, 'B1', 'L1'));
  const cert = c.finalCerts().get('B1');
  assert.equal(cert.status, 'HOLD');
  assert.deepEqual(cert.reasons, ['NO_CALIB']);
});

test('torque retract voids the certificate when no qualified tightening remains', () => {
  const c = new Certifier(OPTS);
  c.ingest(calib('c1', 1000, 'T1', 0, 30000));
  c.ingest(torque('t1', 10000, 'B1', 'T1', 90));
  c.ingest(scan('s1', 10200, 'B1', 'L1'));
  assert.equal(c.finalCerts().get('B1').status, 'OK');
  c.ingest(retract(20000, 'torque', 't1'));
  const final = c.finalCerts().get('B1');
  assert.equal(final.status, 'VOID');
  assert.deepEqual(final.reasons, ['TORQUE_RETRACTED']);
});
