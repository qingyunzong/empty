import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../src/log.js';
import { stride, EMPTY_ROOT } from '../src/page.js';
import { MemStorage, CrashStorage, CrashError } from '../test-helpers/mem-storage.js';

const PAGE_SIZE = 256;
const STRIDE = stride(PAGE_SIZE);
const pad = (n) => 'x'.repeat(n);
const bigEvent = (tenant, n) => ({ tenant, data: pad(100) + n }); // > half a page: 1 event/page

function makeLog(storage, opts = {}) {
  return new AuditLog({ storage, pageSize: PAGE_SIZE, ...opts });
}

test('crash after fsync: committed pages are replayed and visible', () => {
  const storage = new MemStorage();
  const log = makeLog(storage);
  log.append([bigEvent('a', 1), bigEvent('a', 2), bigEvent('a', 3)]);
  const rootBefore = log.root;

  const crashed = storage.crash();
  const recovered = makeLog(crashed);
  const report = recovered.recover();

  assert.equal(report.truncatedBytes, 0);
  assert.equal(report.quarantine, null);
  assert.equal(recovered.lastSeq, 3);
  assert.equal(recovered.root, rootBefore, 'root identical after recovery');
  assert.deepEqual(recovered.verify().valid, true);
});

test('crash after append but before fsync: page is uncommitted and truncated', () => {
  const storage = new MemStorage();
  const log = makeLog(storage);
  log.append([bigEvent('a', 1)]); // page 0 committed (fsynced)
  const committedRoot = log.root;

  // Simulate a second append whose page+commit were written but never
  // fsynced: durable state holds the page bytes WITHOUT the commit record.
  storage.corruptDurable((d) => {
    const log2 = makeLog(new MemStorage());
    log2.append([bigEvent('a', 1), bigEvent('a', 2)]);
    const full = log2.storage.durable;
    return Buffer.concat([d, full.subarray(STRIDE, STRIDE + PAGE_SIZE)]);
  });

  const recovered = makeLog(storage);
  const report = recovered.recover();

  assert.equal(recovered.lastSeq, 1, 'uncommitted event is gone');
  assert.equal(recovered.root, committedRoot);
  assert.equal(report.truncatedBytes, PAGE_SIZE);
  assert.equal(recovered.storage.size(), STRIDE, 'file truncated to last consistent page');
  assert.ok(report.quarantine);
  assert.equal(report.quarantine.offset, STRIDE);
  assert.equal(report.quarantine.length, PAGE_SIZE);
  assert.equal(report.quarantine.reason, 'CORRUPT');
  assert.match(report.quarantine.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.quarantine.headHash, committedRoot);
});

test('torn page (partial write) is truncated and quarantined', () => {
  const storage = new MemStorage();
  const log = makeLog(storage);
  log.append([bigEvent('a', 1)]);
  const root = log.root;
  storage.corruptDurable((d) => Buffer.concat([d, Buffer.alloc(100, 0xab)]));

  const recovered = makeLog(storage);
  const report = recovered.recover();
  assert.equal(recovered.root, root);
  assert.equal(report.truncatedBytes, 100);
  assert.equal(report.quarantine.length, 100);
  assert.equal(recovered.storage.size(), STRIDE);
});

test('orphan page after a committed prefix goes to quarantine with proof', () => {
  const storage = new MemStorage();
  const log = makeLog(storage);
  log.append([bigEvent('a', 1), bigEvent('a', 2), bigEvent('a', 3)]);
  const all = storage.durable;
  // Keep page0+commit and page1's bytes without its commit record.
  storage.corruptDurable(() => Buffer.concat([all.subarray(0, STRIDE), all.subarray(STRIDE, STRIDE + PAGE_SIZE)]));

  const recovered = makeLog(storage);
  const report = recovered.recover();
  assert.equal(recovered.lastSeq, 1);
  assert.equal(report.quarantine.offset, STRIDE);
  assert.equal(report.quarantine.length, PAGE_SIZE);
  assert.equal(report.quarantine.headPageIndex, 0);
});

test('recovery is deterministic: same state, same result', () => {
  const build = () => {
    const storage = new MemStorage();
    const log = makeLog(storage);
    log.append([bigEvent('a', 1), bigEvent('a', 2)]);
    storage.corruptDurable((d) => Buffer.concat([d, Buffer.from('torn-tail')]));
    return storage;
  };
  const r1 = makeLog(build()).recover();
  const r2 = makeLog(build()).recover();
  assert.deepEqual(r1, r2);

  // Recovering an already-recovered log is a no-op with the same root.
  const storage = build();
  const log = makeLog(storage);
  const first = log.recover();
  const second = log.recover();
  assert.equal(second.truncatedBytes, 0);
  assert.equal(second.quarantine, null);
  const third = makeLog(storage);
  third.recover();
  assert.equal(third.root, log.root);
  assert.match(first.quarantine.sha256, /^[0-9a-f]{64}$/);
});

test('index rebuild: append after recovery continues seq without gaps', () => {
  const storage = new MemStorage();
  const log = makeLog(storage);
  log.append([bigEvent('a', 1), bigEvent('a', 2)]);
  const crashed = storage.crash();

  const recovered = makeLog(crashed);
  recovered.recover();
  const result = recovered.append([bigEvent('b', 3), bigEvent('b', 4)]);
  assert.equal(result.appended, 2);
  assert.equal(recovered.lastSeq, 4);
  const scan = recovered.verify();
  assert.equal(scan.valid, true);
  assert.deepEqual(scan.stats, { pages: 4, events: 4, lastSeq: 4, bytes: 4 * STRIDE });
});

test('crash injection during append: un-fsynced pages are lost, fsynced prefix survives', () => {
  const storage = new CrashStorage();
  const log = makeLog(storage);
  log.append([bigEvent('a', 1)]); // 1 page, fsynced

  storage.armCrashAfterFsyncs(1); // crash on the 2nd fsync
  assert.throws(() => log.append([bigEvent('a', 2), bigEvent('a', 3)]), CrashError);

  const crashed = storage.crash();
  const recovered = makeLog(crashed);
  recovered.recover();
  assert.equal(recovered.lastSeq, 1, 'only the fsynced page survives');
  assert.equal(recovered.totalEvents, 1);
});

test('empty log recovers to the empty root', () => {
  const storage = new MemStorage();
  const log = makeLog(storage);
  const report = log.recover();
  assert.equal(log.root, EMPTY_ROOT);
  assert.equal(report.truncatedBytes, 0);
  assert.equal(log.verify().valid, true);
});
