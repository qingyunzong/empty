import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkTmpDir, writeInputs } from './helpers.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const baseReadings = [
  { sensor_id: 'S1', ts: '2026-01-01T00:00:00Z', temp_c: 4 },
  { sensor_id: 'S1', ts: '2026-01-01T00:10:00Z', temp_c: 4 },
];
const baseShipment = {
  batch_id: 'B1',
  sensor_id: 'S1',
  in_time: '2026-01-01T00:00:00Z',
  out_time: '2026-01-01T00:10:00Z',
  min_temp_c: 2,
  max_temp_c: 8,
  max_gap_seconds: 600,
};

test('CLI: valid input exits 0 and writes certs plus index.json', () => {
  const inDir = mkTmpDir('cli-in-');
  const outDir = mkTmpDir('cli-out-');
  writeInputs(inDir, { readings: baseReadings, shipments: [baseShipment], adjustments: [] });
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 0);
  assert.ok(existsSync(path.join(outDir, 'B1-0001.json')));
  assert.ok(existsSync(path.join(outDir, 'index.json')));

  const verify = runCli(['verify', '--out', outDir]);
  assert.equal(verify.status, 0);
});

test('CLI: shipment with inverted times exits 2', () => {
  const inDir = mkTmpDir('cli-in-');
  const outDir = mkTmpDir('cli-out-');
  writeInputs(inDir, {
    readings: baseReadings,
    shipments: [
      { ...baseShipment, in_time: '2026-01-01T01:00:00Z', out_time: '2026-01-01T00:00:00Z' },
    ],
    adjustments: [],
  });
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 2);
});

test('CLI: adjustment with inverted window exits 2', () => {
  const inDir = mkTmpDir('cli-in-');
  const outDir = mkTmpDir('cli-out-');
  writeInputs(inDir, {
    readings: baseReadings,
    shipments: [baseShipment],
    adjustments: [
      { sensor_id: 'S1', start: '2026-01-01T01:00:00Z', end: '2026-01-01T00:00:00Z', offset_c: 1 },
    ],
  });
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 2);
});

test('CLI: adjustment for unknown sensor exits 2', () => {
  const inDir = mkTmpDir('cli-in-');
  const outDir = mkTmpDir('cli-out-');
  writeInputs(inDir, {
    readings: baseReadings,
    shipments: [baseShipment],
    adjustments: [
      { sensor_id: 'S-UNKNOWN', start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:10:00Z', offset_c: 1 },
    ],
  });
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 2);
});

test('CLI: missing input files exit 2', () => {
  const inDir = mkTmpDir('cli-in-');
  const outDir = mkTmpDir('cli-out-');
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 2);
});
