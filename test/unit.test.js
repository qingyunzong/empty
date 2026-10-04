import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalize, digest } from '../lib/canonical.js';
import { applyAdjustments } from '../lib/calibrate.js';
import { computeBatchReport } from '../lib/segments.js';
import { loadInputs } from '../lib/load.js';
import { certify } from '../lib/certify.js';
import { verifyOutDir } from '../lib/verify.js';
import { CertError } from '../lib/errors.js';
import { mkTmpDir, writeInputs } from './helpers.js';

test('canonicalize sorts keys recursively and digest is stable', () => {
  const a = { z: 1, a: { y: 2, b: 3 }, list: [{ k: 1, a: 2 }] };
  const b = { list: [{ a: 2, k: 1 }], a: { b: 3, y: 2 }, z: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(digest(a), digest(b));
  assert.match(digest(a), /^[0-9a-f]{64}$/);
});

test('applyAdjustments: window bounds inclusive, raw preserved, input not mutated', () => {
  const readings = [
    { sensor_id: 'S1', ts: '2026-01-01T00:00:00Z', ts_ms: Date.parse('2026-01-01T00:00:00Z'), temp_c: 5 },
    { sensor_id: 'S1', ts: '2026-01-01T00:05:00Z', ts_ms: Date.parse('2026-01-01T00:05:00Z'), temp_c: 5 },
    { sensor_id: 'S1', ts: '2026-01-01T00:10:00Z', ts_ms: Date.parse('2026-01-01T00:10:00Z'), temp_c: 5 },
    { sensor_id: 'S1', ts: '2026-01-01T00:15:00Z', ts_ms: Date.parse('2026-01-01T00:15:00Z'), temp_c: 5 },
  ];
  const adjustments = [
    {
      sensor_id: 'S1',
      start: '2026-01-01T00:05:00Z',
      end: '2026-01-01T00:10:00Z',
      start_ms: Date.parse('2026-01-01T00:05:00Z'),
      end_ms: Date.parse('2026-01-01T00:10:00Z'),
      offset_c: -1.5,
    },
  ];
  const adjusted = applyAdjustments(readings, adjustments);
  assert.deepEqual(adjusted.map((r) => r.temp_c), [5, 3.5, 3.5, 5]);
  assert.deepEqual(adjusted.map((r) => r.raw_temp_c), [5, 5, 5, 5]);
  assert.deepEqual(adjusted.map((r) => r.adjustments_applied), [0, 1, 1, 0]);
  // Original reading objects untouched (replay-safe).
  assert.deepEqual(readings.map((r) => r.temp_c), [5, 5, 5, 5]);
  // Replaying the same adjustment set over the raw readings is idempotent.
  const replayed = applyAdjustments(readings, adjustments);
  assert.deepEqual(replayed, adjusted);
});

test('applyAdjustments: only matching sensor and window are affected', () => {
  const readings = [
    { sensor_id: 'S2', ts: '2026-01-01T00:05:00Z', ts_ms: Date.parse('2026-01-01T00:05:00Z'), temp_c: 5 },
  ];
  const adjustments = [
    {
      sensor_id: 'S1',
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T00:10:00Z',
      start_ms: Date.parse('2026-01-01T00:00:00Z'),
      end_ms: Date.parse('2026-01-01T00:10:00Z'),
      offset_c: -3,
    },
  ];
  const adjusted = applyAdjustments(readings, adjustments);
  assert.equal(adjusted[0].temp_c, 5);
  assert.equal(adjusted[0].adjustments_applied, 0);
});

test('loadInputs deduplicates identical adjustment events', () => {
  const inDir = mkTmpDir('load-in-');
  const adj = { sensor_id: 'S1', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:10:00Z', offset_c: 1 };
  writeInputs(inDir, {
    readings: [{ sensor_id: 'S1', ts: '2026-01-01T00:00:00Z', temp_c: 4 }],
    shipments: [
      {
        batch_id: 'B1',
        sensor_id: 'S1',
        in_time: '2026-01-01T00:00:00Z',
        out_time: '2026-01-01T00:10:00Z',
      },
    ],
    adjustments: [adj, adj],
  });
  const { adjustments } = loadInputs(inDir);
  assert.equal(adjustments.length, 1);
});

test('loadInputs defaults: thresholds 2..8C and max_gap 300s', () => {
  const inDir = mkTmpDir('load-in-');
  writeInputs(inDir, {
    readings: [{ sensor_id: 'S1', ts: '2026-01-01T00:00:00Z', temp_c: 4 }],
    shipments: [
      {
        batch_id: 'B1',
        sensor_id: 'S1',
        in_time: '2026-01-01T00:00:00Z',
        out_time: '2026-01-01T00:10:00Z',
      },
    ],
  });
  const { shipments } = loadInputs(inDir);
  assert.equal(shipments[0].min_temp_c, 2);
  assert.equal(shipments[0].max_temp_c, 8);
  assert.equal(shipments[0].max_gap_seconds, 300);
});

test('loadInputs rejects inverted shipment times with E_TIME_INVERSION', () => {
  const inDir = mkTmpDir('load-in-');
  writeInputs(inDir, {
    readings: [{ sensor_id: 'S1', ts: '2026-01-01T00:00:00Z', temp_c: 4 }],
    shipments: [
      {
        batch_id: 'B1',
        sensor_id: 'S1',
        in_time: '2026-01-01T02:00:00Z',
        out_time: '2026-01-01T01:00:00Z',
      },
    ],
  });
  assert.throws(() => loadInputs(inDir), (err) => err instanceof CertError && err.code === 'E_TIME_INVERSION');
});

test('loadInputs rejects adjustments for unknown sensors with E_UNKNOWN_SENSOR', () => {
  const inDir = mkTmpDir('load-in-');
  writeInputs(inDir, {
    readings: [{ sensor_id: 'S1', ts: '2026-01-01T00:00:00Z', temp_c: 4 }],
    shipments: [
      {
        batch_id: 'B1',
        sensor_id: 'S1',
        in_time: '2026-01-01T00:00:00Z',
        out_time: '2026-01-01T00:10:00Z',
      },
    ],
    adjustments: [
      { sensor_id: 'GHOST', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:10:00Z', offset_c: 1 },
    ],
  });
  assert.throws(() => loadInputs(inDir), (err) => err instanceof CertError && err.code === 'E_UNKNOWN_SENSOR');
});

test('loadInputs rejects inverted adjustment windows with E_TIME_INVERSION', () => {
  const inDir = mkTmpDir('load-in-');
  writeInputs(inDir, {
    readings: [{ sensor_id: 'S1', ts: '2026-01-01T00:00:00Z', temp_c: 4 }],
    shipments: [
      {
        batch_id: 'B1',
        sensor_id: 'S1',
        in_time: '2026-01-01T00:00:00Z',
        out_time: '2026-01-01T00:10:00Z',
      },
    ],
    adjustments: [
      { sensor_id: 'S1', start: '2026-01-01T00:10:00Z', end: '2026-01-01T00:00:00Z', offset_c: 1 },
    ],
  });
  assert.throws(() => loadInputs(inDir), (err) => err instanceof CertError && err.code === 'E_TIME_INVERSION');
});

test('computeBatchReport: no readings in window means fully UNKNOWN, never non-compliant', () => {
  const shipment = {
    batch_id: 'B1',
    sensor_id: 'S1',
    in_ms: Date.parse('2026-01-01T00:00:00Z'),
    out_ms: Date.parse('2026-01-01T01:00:00Z'),
    min_temp_c: 2,
    max_temp_c: 8,
    max_gap_seconds: 300,
  };
  const report = computeBatchReport(shipment, []);
  assert.equal(report.status, 'UNKNOWN');
  assert.equal(report.unknown_seconds, 3600);
  assert.equal(report.excursion_seconds, 0);
});

test('computeBatchReport: temperature exactly at thresholds is compliant', () => {
  const origin = Date.parse('2026-01-01T00:00:00Z');
  const shipment = {
    batch_id: 'B1',
    sensor_id: 'S1',
    in_ms: origin,
    out_ms: origin + 600_000,
    min_temp_c: 2,
    max_temp_c: 8,
    max_gap_seconds: 300,
  };
  const readings = [
    { sensor_id: 'S1', ts_ms: origin, temp_c: 2 },
    { sensor_id: 'S1', ts_ms: origin + 300_000, temp_c: 8 },
    { sensor_id: 'S1', ts_ms: origin + 600_000, temp_c: 8 },
  ];
  const report = computeBatchReport(shipment, readings);
  assert.equal(report.excursion_seconds, 0);
  assert.equal(report.status, 'COMPLIANT');
});

test('verifyOutDir detects a tampered certificate', () => {
  const inDir = mkTmpDir('tamper-in-');
  const outDir = mkTmpDir('tamper-out-');
  writeInputs(inDir, {
    readings: [{ sensor_id: 'S1', ts: '2026-01-01T00:00:00Z', temp_c: 4 }],
    shipments: [
      {
        batch_id: 'B1',
        sensor_id: 'S1',
        in_time: '2026-01-01T00:00:00Z',
        out_time: '2026-01-01T00:10:00Z',
        max_gap_seconds: 600,
      },
    ],
  });
  certify({ inDir, outDir });
  assert.equal(verifyOutDir(outDir).ok, true);
  const certPath = path.join(outDir, 'B1-0001.json');
  const cert = JSON.parse(readFileSync(certPath, 'utf8'));
  cert.payload.stats.excursion_seconds = 9999;
  writeFileSync(certPath, JSON.stringify(cert, null, 2));
  const result = verifyOutDir(outDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('does not recompute')));
});
