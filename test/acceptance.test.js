import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { certify } from '../lib/certify.js';
import { applyAdjustments } from '../lib/calibrate.js';
import { computeBatchReport } from '../lib/segments.js';
import { verifyOutDir, isUsable, listCertFiles } from '../lib/verify.js';
import { mkTmpDir, writeInputs, mulberry32 } from './helpers.js';

// Independent cross-check: enumerates every sliding window between
// consecutive timeline boundaries (shipment edges + reading timestamps)
// and classifies each window from scratch.
function bruteForceExcursion(adjustedReadings, shipment) {
  const inMs = Date.parse(shipment.in_time);
  const outMs = Date.parse(shipment.out_time);
  const maxGapMs = shipment.max_gap_seconds * 1000;
  const pts = adjustedReadings
    .filter((r) => r.sensor_id === shipment.sensor_id)
    .map((r) => ({ ts: Date.parse(r.ts), temp: r.temp_c }))
    .filter((p) => p.ts >= inMs && p.ts <= outMs)
    .sort((a, b) => a.ts - b.ts);
  const bounds = [...new Set([inMs, ...pts.map((p) => p.ts), outMs])].sort((a, b) => a - b);
  let excursionMs = 0;
  let unknownMs = 0;
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const a = bounds[i];
    const b = bounds[i + 1];
    const dur = b - a;
    if (dur <= 0) continue;
    if (pts.length === 0 || dur > maxGapMs) {
      unknownMs += dur;
      continue;
    }
    let temp = pts[0].temp;
    for (const p of pts) {
      if (p.ts <= a) temp = p.temp;
      else break;
    }
    if (temp < shipment.min_temp_c || temp > shipment.max_temp_c) excursionMs += dur;
  }
  return { excursion_seconds: excursionMs / 1000, unknown_seconds: unknownMs / 1000 };
}

test('acceptance 1: sliding-window enumeration cross-check for n<=12 readings per batch', () => {
  const rand = mulberry32(20261004);
  const base = Date.parse('2026-01-10T00:00:00Z');
  for (let trial = 0; trial < 300; trial += 1) {
    const sensorCount = 1 + Math.floor(rand() * 2);
    const sensors = Array.from({ length: sensorCount }, (_, i) => `S${i + 1}`);
    const readings = [];
    for (const sensor of sensors) {
      const n = 1 + Math.floor(rand() * 12); // 1..12 readings
      for (let i = 0; i < n; i += 1) {
        const offsetSec = Math.floor(rand() * 4800) - 600; // may fall outside the window
        readings.push({
          sensor_id: sensor,
          ts: new Date(base + offsetSec * 1000).toISOString(),
          temp_c: Math.round(rand() * 120) / 10, // 0.0 .. 12.0
        });
      }
    }
    const adjustments = [];
    if (rand() < 0.5) {
      for (const sensor of sensors) {
        adjustments.push({
          sensor_id: sensor,
          start: new Date(base + Math.floor(rand() * 1800) * 1000).toISOString(),
          end: new Date(base + (1800 + Math.floor(rand() * 1800)) * 1000).toISOString(),
          offset_c: Math.round(rand() * 40 - 20) / 10,
        });
      }
    }
    const adjusted = applyAdjustments(readings, adjustments);
    const shipments = [];
    for (const sensor of sensors) {
      const batchCount = 1 + Math.floor(rand() * 2);
      for (let b = 0; b < batchCount; b += 1) {
        const inMs = base + Math.floor(rand() * 1200) * 1000;
        shipments.push({
          batch_id: `B-${sensor}-${b}`,
          sensor_id: sensor,
          in_time: new Date(inMs).toISOString(),
          out_time: new Date(inMs + 3600 * 1000).toISOString(),
          in_ms: inMs,
          out_ms: inMs + 3600 * 1000,
          min_temp_c: 2,
          max_temp_c: 8,
          max_gap_seconds: [60, 300, 900][Math.floor(rand() * 3)],
        });
      }
    }
    for (const shipment of shipments) {
      const report = computeBatchReport(shipment, adjusted);
      const expected = bruteForceExcursion(adjusted, shipment);
      assert.equal(
        report.excursion_seconds,
        expected.excursion_seconds,
        `trial ${trial} batch ${shipment.batch_id}: excursion seconds mismatch`,
      );
      assert.equal(
        report.unknown_seconds,
        expected.unknown_seconds,
        `trial ${trial} batch ${shipment.batch_id}: unknown seconds mismatch`,
      );
    }
  }
});

test('acceptance 2: gap of exactly max_gap is evaluated, max_gap + 1s is UNKNOWN', () => {
  const origin = Date.parse('2026-01-01T00:00:00Z');
  const shipment = {
    batch_id: 'B1',
    sensor_id: 'S1',
    in_time: '2026-01-01T00:00:00Z',
    out_time: '2026-01-01T00:20:00Z',
    in_ms: origin,
    out_ms: origin + 1200 * 1000,
    min_temp_c: 2,
    max_temp_c: 8,
    max_gap_seconds: 300,
  };
  const mk = (entries) =>
    entries.map(([sec, temp]) => ({
      sensor_id: 'S1',
      ts: new Date(origin + sec * 1000).toISOString(),
      ts_ms: origin + sec * 1000,
      raw_temp_c: temp,
      temp_c: temp,
      adjustments_applied: 0,
    }));

  // Exactly max_gap with in-range temps: fully evaluated, compliant.
  const exact = computeBatchReport(shipment, mk([[0, 4], [300, 4], [600, 4], [900, 4], [1200, 4]]));
  assert.equal(exact.unknown_seconds, 0);
  assert.equal(exact.excursion_seconds, 0);
  assert.equal(exact.status, 'COMPLIANT');

  // Exactly max_gap with an out-of-range reading: the 300s segment is
  // evaluated (not hidden as UNKNOWN) and counts as an excursion.
  const exactHot = computeBatchReport(shipment, mk([[0, 9], [300, 4], [600, 4], [900, 4], [1200, 4]]));
  assert.equal(exactHot.unknown_seconds, 0);
  assert.equal(exactHot.excursion_seconds, 300);
  assert.equal(exactHot.status, 'NON_COMPLIANT');

  // max_gap + 1 second: the segment becomes UNKNOWN and must not be
  // judged non-compliant even though the temperature was out of range.
  const over = computeBatchReport(shipment, mk([[0, 9], [301, 4], [601, 4], [901, 4], [1200, 4]]));
  assert.equal(over.unknown_seconds, 301);
  assert.equal(over.excursion_seconds, 0);
  assert.equal(over.status, 'UNKNOWN');
  assert.notEqual(over.status, 'NON_COMPLIANT');
});

test('acceptance 3: new adjustment revokes old cert; chain verifiable; old cert unusable', () => {
  const inDir = mkTmpDir('coldchain-in-');
  const outDir = mkTmpDir('coldchain-out-');
  const readings = [
    { sensor_id: 'S1', ts: '2026-02-01T00:00:00Z', temp_c: 9 },
    { sensor_id: 'S1', ts: '2026-02-01T00:10:00Z', temp_c: 9 },
    { sensor_id: 'S1', ts: '2026-02-01T00:20:00Z', temp_c: 9 },
  ];
  const shipments = [
    {
      batch_id: 'B1',
      sensor_id: 'S1',
      in_time: '2026-02-01T00:00:00Z',
      out_time: '2026-02-01T00:20:00Z',
      min_temp_c: 2,
      max_temp_c: 8,
      max_gap_seconds: 600,
    },
  ];
  writeInputs(inDir, { readings, shipments, adjustments: [] });

  // v1: raw readings show a 20-minute excursion above 8C.
  const run1 = certify({ inDir, outDir });
  const cert1 = JSON.parse(readFileSync(path.join(outDir, 'B1-0001.json'), 'utf8'));
  assert.equal(run1.certs[0].status, 'NON_COMPLIANT');
  assert.equal(cert1.seq, 1);
  assert.equal(cert1.prev_hash, null);
  assert.equal(cert1.payload.stats.excursion_seconds, 1200);

  // A calibration adjustment arrives: the sensor ran 2C high in this window.
  writeInputs(inDir, {
    readings,
    shipments,
    adjustments: [
      { sensor_id: 'S1', start: '2026-02-01T00:00:00Z', end: '2026-02-01T00:20:00Z', offset_c: -2 },
    ],
  });
  const run2 = certify({ inDir, outDir });
  const cert2 = JSON.parse(readFileSync(path.join(outDir, 'B1-0002.json'), 'utf8'));
  assert.equal(run2.certs[0].status, 'COMPLIANT');
  assert.equal(cert2.seq, 2);
  assert.equal(cert2.prev_hash, cert1.hash, 'new cert links to previous hash');
  assert.equal(cert2.payload.stats.excursion_seconds, 0);

  // Old cert is revoked on disk but its hash still recomputes.
  const cert1After = JSON.parse(readFileSync(path.join(outDir, 'B1-0001.json'), 'utf8'));
  assert.equal(cert1After.revoked, true);
  assert.equal(cert1After.hash, cert1.hash);

  // Chain verifies; only the head is usable.
  assert.deepEqual(verifyOutDir(outDir), { ok: true, errors: [] });
  assert.equal(isUsable(outDir, 'B1', cert1.hash), false);
  assert.equal(isUsable(outDir, 'B1', cert2.hash), true);

  // The adjustment itself is later withdrawn: a third cert extends the chain.
  writeInputs(inDir, { readings, shipments, adjustments: [] });
  const run3 = certify({ inDir, outDir });
  const cert3 = JSON.parse(readFileSync(path.join(outDir, 'B1-0003.json'), 'utf8'));
  assert.equal(run3.certs[0].status, 'NON_COMPLIANT');
  assert.equal(cert3.seq, 3);
  assert.equal(cert3.prev_hash, cert2.hash);
  assert.deepEqual(verifyOutDir(outDir), { ok: true, errors: [] });
  assert.equal(isUsable(outDir, 'B1', cert1.hash), false);
  assert.equal(isUsable(outDir, 'B1', cert2.hash), false);
  assert.equal(isUsable(outDir, 'B1', cert3.hash), true);
});

test('acceptance 4: reloading identical adjustments never changes hashes', () => {
  const inDir = mkTmpDir('coldchain-in-');
  const outDir = mkTmpDir('coldchain-out-');
  const readings = [
    { sensor_id: 'S1', ts: '2026-03-01T00:00:00Z', temp_c: 5 },
    { sensor_id: 'S1', ts: '2026-03-01T00:05:00Z', temp_c: 5.5 },
    { sensor_id: 'S1', ts: '2026-03-01T00:10:00Z', temp_c: 5 },
  ];
  const shipments = [
    {
      batch_id: 'B1',
      sensor_id: 'S1',
      in_time: '2026-03-01T00:00:00Z',
      out_time: '2026-03-01T00:10:00Z',
      min_temp_c: 2,
      max_temp_c: 8,
      max_gap_seconds: 300,
    },
  ];
  const adjustment = {
    sensor_id: 'S1',
    start: '2026-03-01T00:00:00Z',
    end: '2026-03-01T00:10:00Z',
    offset_c: 0.5,
  };
  writeInputs(inDir, { readings, shipments, adjustments: [adjustment] });

  const run1 = certify({ inDir, outDir });
  const hash1 = run1.certs[0].hash;
  const index1 = readFileSync(path.join(outDir, 'index.json'), 'utf8');
  const files1 = listCertFiles(outDir);

  // Re-running with the same inputs is a no-op: same hash, same files.
  const run2 = certify({ inDir, outDir });
  assert.equal(run2.certs[0].hash, hash1);
  assert.equal(run2.certs[0].reused, true);
  assert.deepEqual(listCertFiles(outDir), files1);
  assert.equal(readFileSync(path.join(outDir, 'index.json'), 'utf8'), index1);

  // Duplicated adjustment lines (replay) are deduplicated: same hash again.
  writeInputs(inDir, { readings, shipments, adjustments: [adjustment, adjustment, adjustment] });
  const run3 = certify({ inDir, outDir });
  assert.equal(run3.certs[0].hash, hash1);
  assert.deepEqual(listCertFiles(outDir), files1);
  assert.equal(readFileSync(path.join(outDir, 'index.json'), 'utf8'), index1);

  // Raw readings file is never modified by calibration.
  const rawFile = readFileSync(path.join(inDir, 'readings.jsonl'), 'utf8');
  assert.ok(rawFile.includes('"temp_c":5.5'));
});
