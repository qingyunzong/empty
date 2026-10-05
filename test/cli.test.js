import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../cli.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TZ = join(root, 'data', 'tz.json');
const CAL = join(root, 'data', 'calendars.json');

const withTx = (txs, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'daycut-'));
  const txPath = join(dir, 'tx.json');
  writeFileSync(txPath, JSON.stringify(txs));
  return fn(txPath, dir);
};

test('settle emits report and verify replays the certificate', () => {
  withTx(
    [
      { id: 't1', account: 'a', calendar: 'NY', amount: 100, utc: '2024-06-10T15:30:00Z' },
      { id: 't2', account: 'a', calendar: 'NY', amount: -40, utc: '2024-06-10T21:00:00Z' },
    ],
    (txPath, dir) => {
      const outPath = join(dir, 'report.json');
      const settle = runCli(['settle', '--tx', txPath, '--tz', TZ, '--cal', CAL, '--out', outPath]);
      assert.equal(settle.code, 0, settle.stderr);
      const report = JSON.parse(readFileSync(outPath, 'utf8'));
      assert.equal(report.nets.length, 2);
      assert.equal(report.certificate.boundaryHits.length, 1);

      const verify = runCli(['verify', '--tx', txPath, '--tz', TZ, '--cal', CAL, '--report', outPath]);
      assert.equal(verify.code, 0, verify.stderr);
      assert.equal(JSON.parse(verify.stdout).verified, true);
    },
  );
});

test('gap local time exits non-zero with E_GAP', () => {
  withTx(
    [{ id: 'g', account: 'a', calendar: 'NY', amount: 1, local: '2024-03-10T02:30' }],
    (txPath) => {
      const r = runCli(['settle', '--tx', txPath, '--tz', TZ, '--cal', CAL]);
      assert.equal(r.code, 11);
      assert.equal(JSON.parse(r.stderr).error, 'E_GAP');
    },
  );
});

test('overlap local time exits non-zero with E_OVERLAP', () => {
  withTx(
    [{ id: 'o', account: 'a', calendar: 'NY', amount: 1, local: '2024-11-03T01:30' }],
    (txPath) => {
      const r = runCli(['settle', '--tx', txPath, '--tz', TZ, '--cal', CAL]);
      assert.equal(r.code, 12);
      assert.equal(JSON.parse(r.stderr).error, 'E_OVERLAP');
    },
  );
});

test('unknown zone exits non-zero with E_TZ_UNKNOWN', () => {
  withTx(
    [{ id: 'u', account: 'a', calendar: 'NOPE', amount: 1, utc: '2024-06-10T15:00:00Z' }],
    (txPath) => {
      const r = runCli(['settle', '--tx', txPath, '--tz', TZ, '--cal', CAL]);
      assert.equal(r.code, 10);
      assert.equal(JSON.parse(r.stderr).error, 'E_TZ_UNKNOWN');
    },
  );
});

test('out-of-order ledger exits non-zero with E_ORDER', () => {
  withTx(
    [
      { id: 'a', account: 'x', calendar: 'NY', amount: 1, utc: '2024-06-10T15:00:00Z' },
      { id: 'b', account: 'x', calendar: 'NY', amount: 1, utc: '2024-06-10T14:00:00Z' },
    ],
    (txPath) => {
      const r = runCli(['settle', '--tx', txPath, '--tz', TZ, '--cal', CAL]);
      assert.equal(r.code, 13);
      assert.equal(JSON.parse(r.stderr).error, 'E_ORDER');
    },
  );
});

test('verify fails with exit 6 on tampered inputs', () => {
  withTx(
    [{ id: 't1', account: 'a', calendar: 'NY', amount: 100, utc: '2024-06-10T15:30:00Z' }],
    (txPath, dir) => {
      const outPath = join(dir, 'report.json');
      assert.equal(runCli(['settle', '--tx', txPath, '--tz', TZ, '--cal', CAL, '--out', outPath]).code, 0);
      writeFileSync(txPath, JSON.stringify([
        { id: 't1', account: 'a', calendar: 'NY', amount: 101, utc: '2024-06-10T15:30:00Z' },
      ]));
      const verify = runCli(['verify', '--tx', txPath, '--tz', TZ, '--cal', CAL, '--report', outPath]);
      assert.equal(verify.code, 6);
      assert.equal(JSON.parse(verify.stdout).verified, false);
    },
  );
});
