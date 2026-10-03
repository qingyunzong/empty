'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadInputs, evaluateAll } = require('../lib/core');
const { certify, verifyChain, verifyCert, loadIndex } = require('../lib/certs');
const { run } = require('../cli');

function captureRun(argv) {
  const out = [];
  const err = [];
  const code = run(argv, { log: (m) => out.push(m), error: (m) => err.push(m) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coldchain-'));
}

function writeInputs(dir, { readings, shipments, adjustments }) {
  fs.writeFileSync(path.join(dir, 'readings.jsonl'), readings.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'shipments.json'), JSON.stringify(shipments, null, 2));
  fs.writeFileSync(
    path.join(dir, 'adjustments.jsonl'),
    adjustments.length ? adjustments.map((a) => JSON.stringify(a)).join('\n') + '\n' : ''
  );
}

function baseInputs() {
  return {
    readings: [
      { sensor_id: 's1', ts: 0, temp_c: 5 },
      { sensor_id: 's1', ts: 100, temp_c: 5 },
      { sensor_id: 's1', ts: 200, temp_c: 5 },
      { sensor_id: 's1', ts: 300, temp_c: 5 },
    ],
    shipments: [
      { shipment_id: 'sh1', batch_id: 'batch-A', sensor_id: 's1', in_ts: 0, out_ts: 400, min_c: 2, max_c: 8, max_gap_s: 200 },
    ],
    adjustments: [],
  };
}

function runCertify(inDir, outDir) {
  return certify(evaluateAll(loadInputs(inDir)), outDir);
}

test('idempotent: re-running certify with same inputs keeps hash and chain', () => {
  const inDir = tmpdir();
  const outDir = path.join(tmpdir(), 'certs');
  writeInputs(inDir, baseInputs());

  const first = runCertify(inDir, outDir);
  assert.equal(first[0].status, 'issued');
  const hash1 = first[0].hash;
  const filesAfterFirst = fs.readdirSync(outDir).sort();

  const second = runCertify(inDir, outDir);
  assert.equal(second[0].status, 'unchanged');
  assert.equal(second[0].hash, hash1);
  assert.deepEqual(fs.readdirSync(outDir).sort(), filesAfterFirst);

  const index = loadIndex(outDir);
  assert.equal(index.batches['batch-A'].chain.length, 1);
  assert.equal(index.batches['batch-A'].head, hash1);
  assert.ok(verifyChain(outDir).valid);
});

test('new adjustment revokes old cert and links prev_hash; old cert unusable', () => {
  const inDir = tmpdir();
  const outDir = path.join(tmpdir(), 'certs');
  const inputs = baseInputs();
  writeInputs(inDir, inputs);

  const first = runCertify(inDir, outDir);
  const oldHash = first[0].hash;
  const oldFile = loadIndex(outDir).batches['batch-A'].chain[0].file;
  assert.equal(verifyCert(outDir, oldFile).usable, true);

  // Sensor reads 5C but is calibrated +4C within the window -> 9C > max 8C.
  inputs.adjustments.push({ sensor_id: 's1', start_ts: 0, end_ts: 400, offset_c: 4 });
  writeInputs(inDir, inputs);

  const second = runCertify(inDir, outDir);
  assert.equal(second[0].status, 'reissued');
  const newHash = second[0].hash;
  assert.notEqual(newHash, oldHash);

  const index = loadIndex(outDir);
  const chain = index.batches['batch-A'].chain;
  assert.equal(chain.length, 2);
  assert.equal(chain[0].status, 'revoked');
  assert.equal(chain[1].status, 'active');
  assert.equal(index.batches['batch-A'].head, newHash);

  const newCert = JSON.parse(fs.readFileSync(path.join(outDir, chain[1].file), 'utf8'));
  assert.equal(newCert.prev_hash, oldHash);
  assert.equal(newCert.sequence, 1);
  assert.equal(newCert.verdict, 'EXCURSION');
  assert.equal(newCert.excursion_seconds, 400);

  // Chain verifies; old cert is revoked and cannot be used anymore.
  assert.ok(verifyChain(outDir).valid);
  const oldCheck = verifyCert(outDir, oldFile);
  assert.equal(oldCheck.usable, false);
  assert.match(oldCheck.reason, /revoked/);
  assert.equal(verifyCert(outDir, chain[1].file).usable, true);

  // Replaying the same adjustments again is a no-op.
  const third = runCertify(inDir, outDir);
  assert.equal(third[0].status, 'unchanged');
  assert.equal(third[0].hash, newHash);
  assert.equal(loadIndex(outDir).batches['batch-A'].chain.length, 2);
});

test('tampered cert content breaks chain verification', () => {
  const inDir = tmpdir();
  const outDir = path.join(tmpdir(), 'certs');
  writeInputs(inDir, baseInputs());
  runCertify(inDir, outDir);

  const entry = loadIndex(outDir).batches['batch-A'].chain[0];
  const file = path.join(outDir, entry.file);
  const cert = JSON.parse(fs.readFileSync(file, 'utf8'));
  cert.excursion_seconds = 999;
  fs.writeFileSync(file, JSON.stringify(cert, null, 2));

  const report = verifyChain(outDir);
  assert.equal(report.valid, false);
  assert.ok(report.batches['batch-A'].problems.some((p) => p.includes('content hash mismatch')));
});

test('CLI certify writes certs/*.json and index.json', () => {
  const inDir = tmpdir();
  const outDir = path.join(tmpdir(), 'certs');
  writeInputs(inDir, baseInputs());

  const certifyRes = captureRun(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(certifyRes.code, 0);
  assert.match(certifyRes.stdout, /issued\tbatch-A/);
  assert.ok(fs.existsSync(path.join(outDir, 'index.json')));
  const certs = fs.readdirSync(outDir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  assert.equal(certs.length, 1);

  const verifyRes = captureRun(['verify', '--certs', outDir]);
  assert.equal(verifyRes.code, 0);
  assert.equal(JSON.parse(verifyRes.stdout).valid, true);
});
