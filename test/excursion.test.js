'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateShipment, adjustedTemp, normalizeAdjustments } = require('../lib/core');

// Independent reference: enumerate elementary segments between every pair of
// consecutive boundary points (shipment bounds + reading timestamps), find the
// governing reading for each segment, apply the gap rule, and accumulate.
function referenceEval(shipment, readings, adjustments) {
  const rs = readings
    .filter((r) => r.ts >= shipment.in_ts && r.ts <= shipment.out_ts)
    .sort((a, b) => a.ts - b.ts)
    .map((r) => ({ ts: r.ts, temp_c: adjustedTemp(r, adjustments) }));
  const bounds = new Set([shipment.in_ts, shipment.out_ts]);
  for (const r of rs) bounds.add(r.ts);
  const pts = [...bounds].sort((a, b) => a - b);

  let excursion = 0;
  let unknown = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    let temp = null;
    if (rs.length > 0) {
      if (a < rs[0].ts) {
        if (rs[0].ts - shipment.in_ts <= shipment.max_gap_s) temp = rs[0].temp_c;
      } else {
        let idx = 0;
        for (let j = 0; j < rs.length; j++) if (rs[j].ts <= a) idx = j;
        const holdEnd = idx + 1 < rs.length ? rs[idx + 1].ts : shipment.out_ts;
        if (holdEnd - rs[idx].ts <= shipment.max_gap_s) temp = rs[idx].temp_c;
      }
    }
    const duration = b - a;
    if (temp === null) unknown += duration;
    else if (temp < shipment.min_c || temp > shipment.max_c) excursion += duration;
  }
  return { excursion, unknown };
}

// Deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('excursion seconds match independent sliding-window enumeration (n<=12)', () => {
  const rand = rng(20261003);
  for (let trial = 0; trial < 1000; trial++) {
    const inTs = 0;
    const outTs = 2000 + Math.floor(rand() * 2000);
    const shipment = {
      shipment_id: 'sh',
      batch_id: 'b',
      sensor_id: 's',
      in_ts: inTs,
      out_ts: outTs,
      min_c: 2,
      max_c: 8,
      max_gap_s: 100 + Math.floor(rand() * 400),
    };
    const n = Math.floor(rand() * 13); // 0..12 readings
    const readings = [];
    for (let i = 0; i < n; i++) {
      readings.push({
        sensor_id: 's',
        ts: inTs + Math.floor(rand() * (outTs - inTs + 1)),
        temp_c: Math.round((rand() * 14 - 3) * 10) / 10,
      });
    }
    const adjustments = [];
    if (rand() < 0.5) {
      const start = Math.floor(rand() * outTs);
      adjustments.push({
        sensor_id: 's',
        start_ts: start,
        end_ts: start + Math.floor(rand() * 1000),
        offset_c: Math.round((rand() * 4 - 2) * 10) / 10,
      });
    }
    const adjusted = adjustments.map((a) => a);
    const actual = evaluateShipment(shipment, readings, adjusted);
    const expected = referenceEval(shipment, readings, adjusted);
    assert.equal(
      actual.excursion_seconds,
      expected.excursion,
      `trial ${trial}: excursion mismatch ${JSON.stringify({ shipment, readings, adjustments })}`
    );
    assert.equal(
      actual.unknown_seconds,
      expected.unknown,
      `trial ${trial}: unknown mismatch ${JSON.stringify({ shipment, readings, adjustments })}`
    );
    assert.equal(
      actual.excursion_seconds + actual.unknown_seconds + actual.compliant_seconds,
      shipment.out_ts - shipment.in_ts,
      `trial ${trial}: segments must cover the whole window`
    );
  }
});

test('adjustment replay is idempotent and raw readings are preserved', () => {
  const adjustments = [
    { sensor_id: 's', start_ts: 10, end_ts: 20, offset_c: -1.5 },
    { sensor_id: 's', start_ts: 10, end_ts: 20, offset_c: -1.5 }, // duplicate replay
  ];
  const normalized = normalizeAdjustments(adjustments);
  assert.equal(normalized.length, 1);
  const reading = { sensor_id: 's', ts: 15, temp_c: 9.0 };
  assert.equal(adjustedTemp(reading, normalized), 7.5);
  assert.equal(reading.temp_c, 9.0); // raw reading untouched
  // offset does not leak outside its window
  assert.equal(adjustedTemp({ sensor_id: 's', ts: 21, temp_c: 9.0 }, normalized), 9.0);
  assert.equal(adjustedTemp({ sensor_id: 's', ts: 9, temp_c: 9.0 }, normalized), 9.0);
});
