'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coldchain-err-'));
}

function setup({ shipments, adjustments }) {
  const inDir = tmpdir();
  fs.writeFileSync(path.join(inDir, 'readings.jsonl'), JSON.stringify({ sensor_id: 's1', ts: 0, temp_c: 5 }) + '\n');
  fs.writeFileSync(path.join(inDir, 'shipments.json'), JSON.stringify(shipments));
  fs.writeFileSync(path.join(inDir, 'adjustments.jsonl'), adjustments.map((a) => JSON.stringify(a)).join('\n') + '\n');
  return inDir;
}

function runCli(inDir) {
  const outDir = path.join(tmpdir(), 'certs');
  const err = [];
  const code = run(['certify', '--in', inDir, '--out', outDir], { log: () => {}, error: (m) => err.push(m) });
  return { status: code, stderr: err.join('\n') };
}

const goodShipment = { shipment_id: 'sh1', batch_id: 'b1', sensor_id: 's1', in_ts: 0, out_ts: 100, min_c: 2, max_c: 8, max_gap_s: 60 };

test('shipment time inversion exits with code 2', () => {
  const inDir = setup({ shipments: [{ ...goodShipment, in_ts: 100, out_ts: 50 }], adjustments: [] });
  const res = runCli(inDir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /time inversion/);
});

test('adjustment time inversion exits with code 2', () => {
  const inDir = setup({
    shipments: [goodShipment],
    adjustments: [{ sensor_id: 's1', start_ts: 50, end_ts: 10, offset_c: 1 }],
  });
  const res = runCli(inDir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /time inversion/);
});

test('adjustment for unknown sensor exits with code 2', () => {
  const inDir = setup({
    shipments: [goodShipment],
    adjustments: [{ sensor_id: 'ghost', start_ts: 0, end_ts: 10, offset_c: 1 }],
  });
  const res = runCli(inDir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown sensor/);
});
