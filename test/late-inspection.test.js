'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

// Acceptance 2: a late inspection correction stops two batches from issuing
// and produces downstream certificates proving the historical order.

const CONFIG = {
  cmd: 'configure',
  timezones: { 'Asia/Shanghai': 480 },
  rules: [{ id: 'qc', kind: 'weekly', weekday: 1, start: '08:00', durationMinutes: 480, timezone: 'Asia/Shanghai' }],
  holidays: { cancel: [], add: [] },
};

function buildEngine() {
  const e = new Engine();
  e.execute(CONFIG);
  e.execute({ cmd: 'receive', batch: 'B1', qty: 20, expiry: '2026-05-01T00:00:00Z', lot: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'] });
  e.execute({ cmd: 'receive', batch: 'B2', qty: 20, expiry: '2026-06-01T00:00:00Z', lot: ['2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z'] });
  e.execute({ cmd: 'event', batch: 'B1', type: 'available' });
  e.execute({ cmd: 'event', batch: 'B2', type: 'available' });
  // Both inspected clean inside the Monday QC window (00:00-08:00 UTC).
  e.execute({ cmd: 'inspect', batch: 'B1', time: '2026-01-05T02:00:00Z', defects: [] });
  e.execute({ cmd: 'inspect', batch: 'B2', time: '2026-01-05T03:00:00Z', defects: [] });
  // Historical order consumes both batches (FEFO: B1 first).
  const issue = e.execute({ cmd: 'issue', id: 'ORD-1', qty: 30, time: '2026-01-06T00:00:00Z' });
  assert.deepEqual(issue.allocations, [{ batch: 'B1', qty: 20 }, { batch: 'B2', qty: 10 }]);
  return e;
}

test('late defective inspection stops both batches and certifies the historical order', () => {
  const e = buildEngine();

  // Late corrections arrive on 2026-01-07, back-dated to the original window,
  // now carrying defect intervals that hit each batch's lot interval.
  const r1 = e.execute({
    cmd: 'inspect', batch: 'B1',
    time: '2026-01-05T02:00:00Z', recordedAt: '2026-01-07T09:00:00Z',
    defects: [['2026-01-01T12:00:00Z', '2026-01-01T13:00:00Z']],
  });
  assert.equal(r1.defectHit, true);
  assert.equal(r1.recompute.previouslyIssuable, true);
  assert.equal(r1.recompute.issuable, false);
  assert.equal(r1.recompute.issuableTotalBefore, 10);
  assert.equal(r1.recompute.issuableTotalAfter, 10); // B1 already fully consumed

  const r2 = e.execute({
    cmd: 'inspect', batch: 'B2',
    time: '2026-01-05T03:00:00Z', recordedAt: '2026-01-07T09:05:00Z',
    defects: [['2026-01-03T06:00:00Z', '2026-01-03T07:00:00Z']],
  });
  assert.equal(r2.recompute.issuableTotalBefore, 10);
  assert.equal(r2.recompute.issuableTotalAfter, 0); // incremental recompute: nothing issuable now

  // Both batches stopped: any further issue fails.
  assert.throws(
    () => e.execute({ cmd: 'issue', id: 'ORD-2', qty: 1, time: '2026-01-07T10:00:00Z' }),
    (err) => err.code === 'NEGATIVE_INVENTORY',
  );

  // Historical order is NOT recalled, but is proven by certificates.
  const certs = [...r1.recompute.affectedCertificates, ...r2.recompute.affectedCertificates];
  assert.equal(certs.length, 2);
  assert.ok(certs.every((c) => c.issue === 'ORD-1' && c.type === 'affected-downstream-certificate'));
  assert.deepEqual(
    certs.map((c) => [c.batch, c.qty]).sort(),
    [['B1', 20], ['B2', 10]],
  );

  const snap = e.execute({ cmd: 'snapshot' });
  const ord1 = snap.issues.find((i) => i.id === 'ORD-1');
  assert.equal(ord1.status, 'applied', 'issued stock is not auto-recalled');
  assert.equal(snap.batches.find((b) => b.id === 'B2').remaining, 10, 'unrecalled deduction stands');
  assert.equal(snap.batches.every((b) => !b.issuable), true);
  assert.equal(snap.certificates.length, 2);
});

test('late clean correction keeps issuability and generates no certificates', () => {
  const e = buildEngine();
  const r = e.execute({
    cmd: 'inspect', batch: 'B2',
    time: '2026-01-05T03:00:00Z', recordedAt: '2026-01-07T09:00:00Z',
    defects: [],
  });
  assert.equal(r.recompute.issuable, true);
  assert.equal(r.recompute.affectedCertificates.length, 0);
  assert.equal(e.execute({ cmd: 'snapshot' }).certificates.length, 0);
});
