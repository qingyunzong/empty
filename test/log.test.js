import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppendLog, AuditError, recordBytes, verifyLog, READONLY_MARKER } from '../src/log.js';
import { GENESIS_HASH } from '../src/page.js';
import { tmpdir, cleanup, makeRecords } from './helpers.js';

const PAGE = 512;

test('append + flush produces a verifiable chain and deterministic root', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE });
    for (const r of makeRecords('a', 10)) log.append(r);
    log.flush();
    const root1 = log.root();
    log.close();

    const verify = verifyLog(dir, { pageSize: PAGE });
    assert.equal(verify.ok, true);
    assert.equal(verify.root, root1);
    assert.equal(verify.stats.records, 10);

    // same input in a fresh dir => same root (deterministic)
    const dir2 = tmpdir();
    try {
      const log2 = AppendLog.open(dir2, { pageSize: PAGE });
      for (const r of makeRecords('a', 10)) log2.append(r);
      log2.flush();
      assert.equal(log2.root(), root1);
      log2.close();
    } finally {
      cleanup(dir2);
    }
  } finally {
    cleanup(dir);
  }
});

test('empty log root is the genesis hash', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE });
    assert.equal(log.root(), GENESIS_HASH.toString('hex'));
    log.close();
  } finally {
    cleanup(dir);
  }
});

test('SEQ_GAP: non-contiguous per-tenant sequence is rejected', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE });
    log.append({ tenant: 'a', seq: 0, data: 'ok' });
    assert.throws(() => log.append({ tenant: 'a', seq: 2, data: 'gap' }), (err) => {
      assert.equal(err.code, 'SEQ_GAP');
      return true;
    });
    assert.throws(() => log.append({ tenant: 'b', seq: 7, data: 'bad start' }), (err) => {
      assert.equal(err.code, 'SEQ_GAP');
      return true;
    });
    // independent tenants have independent sequences
    log.append({ tenant: 'b', seq: 0, data: 'fine' });
    log.flush();
    log.close();
    const verify = verifyLog(dir, { pageSize: PAGE });
    assert.equal(verify.ok, true);
    assert.equal(verify.stats.records, 2);
  } finally {
    cleanup(dir);
  }
});

test('QUOTA: hard disk quota is enforced and aging cannot override it', () => {
  const dir = tmpdir();
  try {
    const record = { tenant: 'a', seq: 0, data: 'x'.repeat(50) };
    const bytes = recordBytes(record);
    const quota = bytes * 3; // room for exactly 3 records
    const log = AppendLog.open(dir, {
      pageSize: PAGE,
      quotas: { a: { diskBytes: quota, weight: 1000, ratePerSec: 100000 } },
      agingFactor: 1000, // extreme aging must not help
    });
    log.append({ ...record, seq: 0 });
    log.append({ ...record, seq: 1 });
    log.append({ ...record, seq: 2 });
    assert.throws(() => log.append({ ...record, seq: 3 }), (err) => {
      assert.equal(err.code, 'QUOTA');
      return true;
    });
    log.flush();
    // quota still enforced after flush (committed + buffered accounting)
    assert.throws(() => log.append({ ...record, seq: 3 }), (err) => {
      assert.equal(err.code, 'QUOTA');
      return true;
    });
    log.close();
    const verify = verifyLog(dir, { pageSize: PAGE });
    assert.equal(verify.stats.tenants.a.bytes, bytes * 3);
    assert.ok(verify.stats.tenants.a.bytes <= quota);
  } finally {
    cleanup(dir);
  }
});

test('READONLY: appends are rejected on read-only logs', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE });
    log.append({ tenant: 'a', seq: 0, data: 'x' });
    log.flush();
    log.close();

    const ro = AppendLog.open(dir, { pageSize: PAGE, readonly: true });
    assert.throws(() => ro.append({ tenant: 'a', seq: 1, data: 'y' }), (err) => {
      assert.equal(err.code, 'READONLY');
      return true;
    });
    ro.close();

    // marker file also forces read-only
    fs.writeFileSync(path.join(dir, READONLY_MARKER), '');
    const marked = AppendLog.open(dir, { pageSize: PAGE });
    assert.throws(() => marked.append({ tenant: 'a', seq: 1, data: 'y' }), (err) => {
      assert.equal(err.code, 'READONLY');
      return true;
    });
    marked.close();
  } finally {
    cleanup(dir);
  }
});

test('bufferPages bounds the write buffer and triggers auto-flush', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE, bufferPages: 1 });
    // capacity 384 bytes/page; each record ~60 bytes; 1 page of buffer => auto flush
    for (const r of makeRecords('a', 20)) log.append(r);
    assert.ok(log.stats().pages > 0, 'expected auto-flush to commit pages');
    log.flush();
    const verify = verifyLog(dir, { pageSize: PAGE });
    assert.equal(verify.stats.records, 20);
    log.close();
  } finally {
    cleanup(dir);
  }
});

test('interleaved tenants keep per-tenant order through page packing', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE });
    for (let i = 0; i < 30; i += 1) {
      log.append({ tenant: 'a', seq: i, data: 'a'.repeat(20) });
      log.append({ tenant: 'b', seq: i, data: 'b'.repeat(60) });
    }
    log.flush();
    log.close();
    const verify = verifyLog(dir, { pageSize: PAGE });
    assert.equal(verify.ok, true);
    assert.equal(verify.stats.tenants.a.count, 30);
    assert.equal(verify.stats.tenants.b.count, 30);
  } finally {
    cleanup(dir);
  }
});
