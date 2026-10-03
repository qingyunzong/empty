import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../src/log.js';
import { CrashStorage, CrashError, mulberry32 } from '../test-helpers/mem-storage.js';
import { NaiveLog } from '../test-helpers/naive.js';

const PAGE_SIZE = 256;
// Events padded so each one fills more than half a page: exactly 1 event per
// page, so "crash after k fsyncs" in the model maps to "first k events kept".
const makeEvent = (tenant, n) => ({ tenant, data: `event-${n}-` + 'z'.repeat(100) });

function replay(ops) {
  let storage = new CrashStorage();
  let log = new AuditLog({ storage, pageSize: PAGE_SIZE });
  const naive = new NaiveLog();

  for (const op of ops) {
    if (op.crashAfterFsyncs == null) {
      log.append(op.batch);
      naive.appendBatch(op.batch);
    } else {
      storage.armCrashAfterFsyncs(storage.fsyncs + op.crashAfterFsyncs);
      try {
        log.append(op.batch);
      } catch (err) {
        assert.ok(err instanceof CrashError, `unexpected error: ${err}`);
      }
      storage = storage.crash();
      if (op.torn) {
        storage.corruptDurable((d) => Buffer.concat([d, Buffer.from('torn!')]));
      }
      log = new AuditLog({ storage, pageSize: PAGE_SIZE });
      log.recover();
      naive.appendBatch(op.batch, op.crashAfterFsyncs);
    }
  }
  log.recover();
  return { log, naive };
}

test('n<=10 cross-check against the naive replayer', () => {
  const rand = mulberry32(0x5eed);
  const TRIALS = 300;
  for (let trial = 0; trial < TRIALS; trial++) {
    const nOps = 1 + Math.floor(rand() * 10); // 1..10 ops
    const ops = [];
    let seq = 0;
    for (let i = 0; i < nOps; i++) {
      const batchSize = 1 + Math.floor(rand() * 3); // 1..3 events (=> pages)
      // Single-tenant batches: the fair scheduler preserves FIFO order within
      // one tenant, so the naive model's input order equals the write order.
      // (Cross-tenant reordering is covered by the scheduler tests.)
      const tenant = `t${Math.floor(rand() * 3)}`;
      const batch = Array.from({ length: batchSize }, () => makeEvent(tenant, seq++));
      const crashes = rand() < 0.5;
      ops.push({
        batch,
        crashAfterFsyncs: crashes ? Math.floor(rand() * (batchSize + 1)) : null,
        torn: crashes && rand() < 0.5,
      });
    }
    const { log, naive } = replay(ops);
    const scan = log.scanOnly();
    const label = `trial ${trial} (ops: ${JSON.stringify(ops.map((o) => ({ n: o.batch.length, c: o.crashAfterFsyncs, t: o.torn })))})`;
    // The fair scheduler may reorder events across tenants, so the recovery
    // cross-check compares the committed SET of events plus seq continuity.
    assert.deepEqual(
      scan.events.map((e) => `${e.tenant}/${e.data}`).sort(),
      naive.events.map((e) => `${e.tenant}/${e.data}`).sort(),
      `${label}: recovered events diverge from naive model`,
    );
    assert.deepEqual(scan.events.map((e) => e.seq), Array.from({ length: scan.events.length }, (_, i) => i + 1), `${label}: seqs not contiguous`);
    assert.equal(log.verify().valid, true, `trial ${trial}: post-recovery log must verify`);
    // Recovery is deterministic: a second pass over the same bytes is a no-op.
    const again = log.recover();
    assert.equal(again.truncatedBytes, 0);
    assert.equal(again.quarantine, null);
  }
});
