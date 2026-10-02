import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppendLog, recoverLog, verifyLog, dataFileOf } from '../src/log.js';
import { GENESIS_HASH } from '../src/page.js';
import { tmpdir, cleanup, makeRecords } from './helpers.js';

const PAGE = 512; // capacity = 512 - 96 - 32 = 384 bytes of payload

test('crash before fsync: uncommitted page is truncated and quarantined with proof', () => {
  const dir = tmpdir();
  try {
    let crashed = false;
    const log = AppendLog.open(dir, {
      pageSize: PAGE,
      onBeforeFsync: (pageIndex) => {
        if (pageIndex === 1) {
          crashed = true;
          throw new Error('CRASH before fsync');
        }
      },
    });
    for (const r of makeRecords('a', 20)) log.append(r);
    assert.throws(() => log.flush(), /CRASH before fsync/);
    assert.ok(crashed);
    log.simulateCrash(); // un-fsynced page is lost (deterministic torn tail)

    const report = recoverLog(dir, { pageSize: PAGE });
    assert.equal(report.committedPages, 1);
    assert.equal(report.truncatedBytes, PAGE);
    assert.equal(report.quarantine.length, 1);
    const proof = report.quarantine[0];
    assert.equal(proof.offset, PAGE);
    assert.equal(proof.length, PAGE);
    assert.equal(proof.reason, 'BAD_MAGIC'); // torn page reads as zeros
    assert.match(proof.sha256, /^[0-9a-f]{64}$/);
    assert.equal(proof.lastCommittedPage, 0);

    // quarantine artifacts exist on disk and match the proof
    const orphan = fs.readFileSync(path.join(dir, 'quarantine', `orphan-${PAGE}.bin`));
    assert.equal(orphan.length, PAGE);
    const proofOnDisk = JSON.parse(
      fs.readFileSync(path.join(dir, 'quarantine', `orphan-${PAGE}.proof.json`), 'utf8'),
    );
    assert.deepEqual(proofOnDisk, proof);

    // file truncated to the consistent prefix
    assert.equal(fs.statSync(dataFileOf(dir)).size, PAGE);

    // recovery is deterministic: a second pass is a no-op with the same root
    const again = recoverLog(dir, { pageSize: PAGE });
    assert.equal(again.truncatedBytes, 0);
    assert.equal(again.quarantine.length, 0);
    assert.equal(again.root, report.root);

    // log is appendable after recovery and the chain continues
    const reopened = AppendLog.open(dir, { pageSize: PAGE });
    const state = verifyLog(dir, { pageSize: PAGE });
    const nextSeq = state.stats.tenants.a.count;
    reopened.append({ tenant: 'a', seq: nextSeq, data: 'after-recovery' });
    reopened.flush();
    reopened.close();
    const after = verifyLog(dir, { pageSize: PAGE });
    assert.equal(after.ok, true);
    assert.notEqual(after.root, report.root);
  } finally {
    cleanup(dir);
  }
});

test('crash after fsync: every committed page replays visible', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE });
    for (const r of makeRecords('a', 30)) log.append(r);
    log.flush();
    const rootBefore = log.root();
    const pagesBefore = log.stats().pages;
    assert.ok(pagesBefore >= 2);
    log.simulateCrash(); // all pages were fsynced: nothing may be lost

    const report = recoverLog(dir, { pageSize: PAGE });
    assert.equal(report.committedPages, pagesBefore);
    assert.equal(report.truncatedBytes, 0);
    assert.equal(report.quarantine.length, 0);
    assert.equal(report.root, rootBefore);
    assert.equal(report.records, 30);

    const verify = verifyLog(dir, { pageSize: PAGE });
    assert.equal(verify.ok, true);
    assert.equal(verify.root, rootBefore);
    assert.equal(verify.stats.tenants.a.count, 30);
  } finally {
    cleanup(dir);
  }
});

test('unflushed buffered records are lost on crash but committed pages survive', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE, bufferPages: 8 });
    for (const r of makeRecords('a', 5)) log.append(r);
    log.flush(); // page 0 committed
    const rootCommitted = log.root();
    for (const r of makeRecords('a', 3, { startSeq: 5 })) log.append(r); // buffered only
    log.simulateCrash();

    const report = recoverLog(dir, { pageSize: PAGE });
    assert.equal(report.records, 5);
    assert.equal(report.root, rootCommitted);
  } finally {
    cleanup(dir);
  }
});

test('recover on empty and missing logs is deterministic', () => {
  const dir = tmpdir();
  try {
    const report = recoverLog(dir, { pageSize: PAGE });
    assert.equal(report.committedPages, 0);
    assert.equal(report.records, 0);
    assert.equal(report.root, GENESIS_HASH.toString('hex'));
    assert.equal(report.truncatedBytes, 0);
  } finally {
    cleanup(dir);
  }
});
