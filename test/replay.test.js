import test from 'node:test';
import assert from 'node:assert/strict';
import { AppendLog, verifyLog } from '../src/log.js';
import { naiveReplay } from '../src/naive.js';
import { tmpdir, cleanup } from './helpers.js';

const PAGE = 512;

// deterministic PRNG (mulberry32) so the cross-check is reproducible
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('indexed replay matches the naive replayer for n <= 10 records', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const rand = rng(seed);
    const n = seed % 11; // 0..10 records
    const tenants = ['alpha', 'beta', 'gamma'];
    const seqs = new Map();
    const records = [];
    for (let i = 0; i < n; i += 1) {
      const tenant = tenants[Math.floor(rand() * tenants.length)];
      const seq = seqs.get(tenant) ?? 0;
      seqs.set(tenant, seq + 1);
      records.push({ tenant, seq, data: 'd'.repeat(Math.floor(rand() * 60)) });
    }
    const dir = tmpdir();
    try {
      const log = AppendLog.open(dir, { pageSize: PAGE });
      for (const r of records) log.append(r);
      log.flush();
      const root = log.root();
      log.close();

      const indexed = verifyLog(dir, { pageSize: PAGE });
      const naive = naiveReplay(dir, { pageSize: PAGE });

      assert.equal(indexed.ok, true, `seed ${seed}: indexed verify failed`);
      assert.equal(naive.corrupt, null, `seed ${seed}: naive replayer found corruption`);
      assert.equal(naive.root, indexed.root, `seed ${seed}: root mismatch`);
      assert.equal(naive.root, root, `seed ${seed}: root vs writer mismatch`);
      assert.equal(naive.pages, indexed.stats.pages, `seed ${seed}: page count mismatch`);
      assert.equal(naive.records, indexed.stats.records, `seed ${seed}: record count mismatch`);
      assert.deepEqual(
        Object.keys(naive.tenants).sort(),
        Object.keys(indexed.stats.tenants).sort(),
        `seed ${seed}: tenant set mismatch`,
      );
      for (const [tenant, stats] of Object.entries(naive.tenants)) {
        const other = indexed.stats.tenants[tenant];
        assert.equal(other.count, stats.count, `seed ${seed} ${tenant}: count`);
        assert.equal(other.bytes, stats.bytes, `seed ${seed} ${tenant}: bytes`);
      }
    } finally {
      cleanup(dir);
    }
  }
});

test('naive replayer agrees on multi-page logs beyond n=10', () => {
  const dir = tmpdir();
  try {
    const log = AppendLog.open(dir, { pageSize: PAGE });
    const seqs = new Map();
    const rand = rng(1234);
    for (let i = 0; i < 250; i += 1) {
      const tenant = `t${i % 5}`;
      const seq = seqs.get(tenant) ?? 0;
      seqs.set(tenant, seq + 1);
      log.append({ tenant, seq, data: 'x'.repeat(Math.floor(rand() * 80)) });
    }
    log.flush();
    log.close();
    const indexed = verifyLog(dir, { pageSize: PAGE });
    const naive = naiveReplay(dir, { pageSize: PAGE });
    assert.ok(indexed.stats.pages > 1);
    assert.equal(naive.root, indexed.root);
    assert.equal(naive.records, indexed.stats.records);
  } finally {
    cleanup(dir);
  }
});
