import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AppendLog, verifyLog, dataFileOf } from '../src/log.js';
import { HEADER_SIZE } from '../src/page.js';
import { tmpdir, cleanup, makeRecords } from './helpers.js';

const PAGE = 512;

function buildLog(dir, records = 30) {
  const log = AppendLog.open(dir, { pageSize: PAGE });
  for (const r of makeRecords('a', records)) log.append(r);
  log.flush();
  const root = log.root();
  log.close();
  return root;
}

function tamper(dir, offset, write) {
  const file = dataFileOf(dir);
  const fd = fs.openSync(file, 'r+');
  const buf = Buffer.from([write]);
  fs.writeSync(fd, buf, 0, 1, offset);
  fs.closeSync(fd);
}

test('clean log verifies ok', () => {
  const dir = tmpdir();
  try {
    const root = buildLog(dir);
    const report = verifyLog(dir, { pageSize: PAGE });
    assert.equal(report.ok, true);
    assert.equal(report.root, root);
    assert.equal(report.violations.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('tampered payload byte is rejected (CORRUPT)', () => {
  const dir = tmpdir();
  try {
    buildLog(dir);
    tamper(dir, PAGE + HEADER_SIZE + 5, 0xff); // inside page 1 payload
    const report = verifyLog(dir, { pageSize: PAGE });
    assert.equal(report.ok, false);
    const corrupt = report.violations.filter((v) => v.code === 'CORRUPT');
    assert.ok(corrupt.length >= 1);
    assert.equal(corrupt[0].pageIndex, 1);
    assert.equal(corrupt[0].reason, 'BAD_PAYLOAD_HASH');
  } finally {
    cleanup(dir);
  }
});

test('tampered chain link is rejected (CORRUPT)', () => {
  const dir = tmpdir();
  try {
    buildLog(dir);
    tamper(dir, PAGE + 25, 0x01); // prevHash field of page 1
    const report = verifyLog(dir, { pageSize: PAGE });
    assert.equal(report.ok, false);
    assert.equal(report.violations[0].code, 'CORRUPT');
    // trailer covers the header, so this is caught as a hash mismatch
    assert.equal(report.violations[0].reason, 'BAD_TRAILER');
  } finally {
    cleanup(dir);
  }
});

test('tampered trailer is rejected (CORRUPT)', () => {
  const dir = tmpdir();
  try {
    buildLog(dir);
    tamper(dir, 2 * PAGE - 1, 0xaa); // last byte of page 1 trailer
    const report = verifyLog(dir, { pageSize: PAGE });
    assert.equal(report.ok, false);
    assert.equal(report.violations[0].reason, 'BAD_TRAILER');
  } finally {
    cleanup(dir);
  }
});

test('truncated tail (partial page) is reported', () => {
  const dir = tmpdir();
  try {
    buildLog(dir);
    fs.truncateSync(dataFileOf(dir), PAGE + 100);
    const report = verifyLog(dir, { pageSize: PAGE });
    assert.equal(report.ok, false);
    assert.equal(report.violations[0].code, 'CORRUPT');
    assert.equal(report.stats.trailingBytes, 100);
  } finally {
    cleanup(dir);
  }
});

test('verify never mutates the log', () => {
  const dir = tmpdir();
  try {
    buildLog(dir);
    tamper(dir, PAGE + HEADER_SIZE + 5, 0xff);
    const before = fs.readFileSync(dataFileOf(dir));
    verifyLog(dir, { pageSize: PAGE });
    const after = fs.readFileSync(dataFileOf(dir));
    assert.ok(before.equals(after));
  } finally {
    cleanup(dir);
  }
});
