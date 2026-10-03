import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archive } from '../src/archive.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-agg-'));
}

function approxEqual(a, b, eps = 1e-12) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < eps;
}

test('interleaved corrections: indexed window mean matches brute replay', () => {
  const dir = tmpdir();
  const archive = new Archive(dir);

  archive.ingest([
    { site: 'S1', validTime: '2026-01-01T00:00:00Z', value: 10, quality: 'good' },
    { site: 'S1', validTime: '2026-01-01T06:00:00Z', value: 20, quality: 'suspect' },
    { site: 'S1', validTime: '2026-01-02T00:00:00Z', value: null, quality: 'good' },
    { site: 'S2', validTime: '2026-01-01T03:00:00Z', value: 5, quality: 'good' },
  ]);

  archive.correct({
    batchId: 'B1',
    corrections: [
      { op: 'replace', site: 'S1', validTime: '2026-01-01T00:00:00Z', value: 12, quality: 'good' },
      { op: 'flag', site: 'S1', validTime: '2026-01-01T06:00:00Z', value: 20, quality: 'bad', flags: ['spike'] },
    ],
  });

  archive.correct({
    batchId: 'B2',
    corrections: [
      { op: 'replace', site: 'S1', validTime: '2026-01-01T00:00:00Z', value: 11, quality: 'suspect' },
      { op: 'delete', site: 'S1', validTime: '2026-01-02T00:00:00Z' },
    ],
  });

  archive.ingest([
    { site: 'S1', validTime: '2026-01-01T12:00:00Z', value: 8, quality: 'unknown' },
  ]);

  archive.correct({
    batchId: 'B3',
    corrections: [
      { op: 'flag', site: 'S1', validTime: '2026-01-01T12:00:00Z', value: 8, quality: 'good', flags: ['reviewed'] },
    ],
  });

  const windows = [
    ['2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'],
    ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'],
    ['2026-01-01T05:00:00Z', '2026-01-01T13:00:00Z'],
    ['2026-01-01T06:00:00Z', '2026-01-02T00:00:00Z'],
    ['2025-12-31T12:00:00Z', '2026-01-02T12:00:00Z'],
  ];

  for (const [from, to] of windows) {
    const indexed = archive.query('S1', from, to);
    const brute = archive.query('S1', from, to, { brute: true });
    assert.ok(approxEqual(indexed.weightedMean, brute.weightedMean), `mean mismatch for [${from}, ${to}): ${indexed.weightedMean} vs ${brute.weightedMean}`);
    assert.equal(indexed.nonNull, brute.nonNull);
    assert.equal(indexed.nullCount, brute.nullCount);
    assert.equal(indexed.trust, brute.trust);
  }

  const day1 = archive.query('S1', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
  // effective: 00:00 -> 11@suspect (w=0.5), 06:00 -> 20@bad (w=0), 12:00 -> 8@good (w=1)
  assert.ok(approxEqual(day1.weightedMean, (11 * 0.5 + 8 * 1.0) / 1.5));
  assert.equal(day1.nonNull, 3);
  assert.equal(day1.nullCount, 0);

  const other = archive.query('S2', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
  assert.ok(approxEqual(other.weightedMean, 5));
});

test('randomized interleaving: indexed always equals brute', () => {
  const dir = tmpdir();
  const archive = new Archive(dir);
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sites = ['A', 'B'];
  const qualities = ['good', 'suspect', 'unknown', 'bad'];
  const times = [];
  for (let d = 1; d <= 3; d++) {
    for (let h = 0; h < 24; h += 3) {
      times.push(`2026-02-0${d}T${String(h).padStart(2, '0')}:00:00Z`);
    }
  }
  for (let round = 0; round < 30; round++) {
    const kind = rand();
    if (kind < 0.4) {
      const records = [];
      for (let i = 0; i < 3; i++) {
        records.push({
          site: sites[Math.floor(rand() * sites.length)],
          validTime: times[Math.floor(rand() * times.length)],
          value: rand() < 0.2 ? null : Math.round(rand() * 300) / 10,
          quality: qualities[Math.floor(rand() * qualities.length)],
        });
      }
      archive.ingest(records);
    } else if (kind < 0.8) {
      const corrections = [];
      for (let i = 0; i < 3; i++) {
        const op = rand() < 0.15 ? 'delete' : rand() < 0.5 ? 'replace' : 'flag';
        corrections.push({
          op,
          site: sites[Math.floor(rand() * sites.length)],
          validTime: times[Math.floor(rand() * times.length)],
          value: rand() < 0.2 ? null : Math.round(rand() * 300) / 10,
          quality: qualities[Math.floor(rand() * qualities.length)],
        });
      }
      archive.correct({ batchId: `RB${round}`, corrections });
    } else {
      const ids = [...archive.batches.keys()].filter((b) => !archive.batches.get(b).undone);
      if (ids.length > 0) archive.undo(ids[Math.floor(rand() * ids.length)]);
    }
  }
  for (const site of sites) {
    for (const [from, to] of [
      ['2026-02-01T00:00:00Z', '2026-02-04T00:00:00Z'],
      ['2026-02-01T06:00:00Z', '2026-02-03T18:00:00Z'],
      ['2026-02-02T00:00:00Z', '2026-02-03T00:00:00Z'],
    ]) {
      const indexed = archive.query(site, from, to);
      const brute = archive.query(site, from, to, { brute: true });
      assert.ok(approxEqual(indexed.weightedMean, brute.weightedMean), `${site} [${from},${to})`);
      assert.equal(indexed.nonNull, brute.nonNull);
      assert.equal(indexed.nullCount, brute.nullCount);
      assert.equal(indexed.trust, brute.trust);
    }
  }
});
