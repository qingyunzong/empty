import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as engine from '../src/engine.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'riskdb-'));
}

function insertOps(n, prefix = 'a', riskPrefix = 'r') {
  return Array.from({ length: n }, (_, i) => ({
    op: 'insert',
    account: `${prefix}${i + 1}`,
    risk: `${riskPrefix}${i + 1}`,
    balance: (i + 1) * 100,
  }));
}

test('backfill with concurrent insert/pay/reverse stays consistent with versioned scan', () => {
  const dir = tmpdir();
  const s = engine.openStore(dir);

  engine.commit(s, { ops: insertOps(3) });
  engine.commit(s, { ops: insertOps(3, 'b', 'rb') });

  // start backfill, then interleave live transactions with scan steps
  let r = engine.buildIndex(s, { stopAfter: 2, batchSize: 2 });
  assert.equal(r.completed, false);
  assert.equal(engine.status(s).index.state, 'building');

  engine.commit(s, { ops: [{ op: 'insert', account: 'c1', risk: 'rc1', balance: 55 }] });
  engine.commit(s, { ops: [{ op: 'pay', id: 'p1', from: 'a1', to: 'a2', amount: 40 }] });

  r = engine.buildIndex(s, { stopAfter: 2, batchSize: 2 });
  assert.equal(r.completed, false);

  engine.commit(s, { ops: [{ op: 'reverse', payment: 'p1' }] });
  engine.commit(s, { ops: [{ op: 'setRisk', account: 'b1', risk: 'rb9' }] });
  engine.commit(s, { ops: [{ op: 'pay', id: 'p2', from: 'a3', to: 'c1', amount: 100 }] });

  r = engine.buildIndex(s, { batchSize: 2 });
  assert.equal(r.completed, true);
  const st = engine.status(s);
  assert.equal(st.index.state, 'online');
  assert.equal(typeof st.index.watermark, 'number');

  const risks = ['r1', 'r2', 'r3', 'rb1', 'rb2', 'rb3', 'rb9', 'rc1', 'missing'];
  // every snapshot version: default query path must equal the reference scan
  for (let v = 0; v <= s.version; v++) {
    for (const risk of risks) {
      const got = engine.queryByRisk(s, risk, v);
      const ref = engine.scanByRisk(s, risk, v);
      assert.deepEqual(
        got.accounts.map((a) => a.account),
        ref,
        `risk=${risk} v=${v}`,
      );
    }
  }
  // versions at/after the watermark: index path and scan path must agree
  for (let v = st.index.watermark; v <= s.version; v++) {
    for (const risk of risks) {
      const viaIndex = engine.queryByRisk(s, risk, v, { force: 'index' });
      const viaScan = engine.queryByRisk(s, risk, v, { force: 'scan' });
      assert.equal(viaIndex.source, 'index');
      assert.deepEqual(viaIndex.accounts, viaScan.accounts, `risk=${risk} v=${v}`);
    }
  }

  // replay from WAL into a fresh process state and re-verify
  const s2 = engine.openStore(dir);
  assert.equal(engine.status(s2).index.state, 'online');
  for (let v = 0; v <= s2.version; v++) {
    for (const risk of risks) {
      const got = engine.queryByRisk(s2, risk, v);
      assert.deepEqual(got.accounts.map((a) => a.account), engine.scanByRisk(s2, risk, v));
    }
  }
  // balances reflect pay + reversal + pay
  const q = engine.queryByRisk(s2, 'rc1');
  assert.equal(q.accounts[0].balance, 155);
});

test('crash mid-backfill resumes without duplicate account registration', () => {
  const dir = tmpdir();
  const s = engine.openStore(dir);
  engine.commit(s, { ops: insertOps(5) });

  const crash = engine.crashBackfill(s);
  assert.equal(crash.crashed, true);
  assert.equal(crash.cursor, 3); // ceil(5/2), half the scan done
  assert.equal(engine.status(s).index.state, 'building');
  assert.equal(engine.status(s).index.watermark, null);

  // live tx while the index is half-built: double-write moves a4 (not yet
  // scanned) off r4, so the resumed scan must skip re-registering it
  engine.commit(s, { ops: [{ op: 'setRisk', account: 'a4', risk: 'r4x' }] });

  // restart from disk and resume
  const s2 = engine.openStore(dir);
  assert.equal(engine.status(s2).index.state, 'building');
  const res = engine.buildIndex(s2);
  assert.equal(res.completed, true);
  assert.equal(res.resumed, true);
  assert.ok(res.skipped >= 1, 'resume must skip already-registered/double-written accounts');

  // no account registered twice across the whole versioned index
  const seen = new Set();
  for (const [risk, list] of s2.index.entries) {
    for (const e of list) {
      if (e.end !== Infinity) continue;
      assert.ok(!seen.has(e.account), `duplicate live registration for ${e.account}`);
      seen.add(e.account);
    }
  }
  // exactly one live entry per risk flag
  for (const list of s2.index.entries.values()) {
    assert.equal(list.filter((e) => e.end === Infinity).length, 1);
  }

  // index results match the reference scan for every queryable version
  const st = engine.status(s2);
  for (let v = st.index.watermark; v <= s2.version; v++) {
    for (const risk of ['r1', 'r2', 'r3', 'r4', 'r4x', 'r5']) {
      const viaIndex = engine.queryByRisk(s2, risk, v, { force: 'index' });
      assert.deepEqual(viaIndex.accounts.map((a) => a.account), engine.scanByRisk(s2, risk, v));
    }
  }
  // a4 answers under the new flag, not the stale one
  assert.deepEqual(engine.queryByRisk(s2, 'r4').accounts, []);
  assert.equal(engine.queryByRisk(s2, 'r4x').accounts[0].account, 'a4');
});

test('old snapshots are isolated and duplicate risk flags raise E_DUP_RISK', () => {
  const dir = tmpdir();
  const s = engine.openStore(dir);

  engine.commit(s, { ops: [{ op: 'insert', account: 'a1', risk: 'r1', balance: 100 }] });
  const v1 = s.version;
  engine.commit(s, { ops: [{ op: 'insert', account: 'a2', risk: 'r2', balance: 50 }] });
  engine.commit(s, { ops: [{ op: 'setRisk', account: 'a1', risk: 'r3' }] });

  // old snapshot still sees the old flag even after the index goes online
  engine.buildIndex(s);
  engine.commit(s, { ops: [{ op: 'insert', account: 'a3', risk: 'r1', balance: 5 }] }); // r1 free again

  const oldQ = engine.queryByRisk(s, 'r1', v1);
  assert.deepEqual(oldQ.accounts.map((a) => a.account), ['a1']);
  assert.equal(oldQ.accounts[0].balance, 100);
  const nowQ = engine.queryByRisk(s, 'r1');
  assert.deepEqual(nowQ.accounts.map((a) => a.account), ['a3']);
  assert.equal(nowQ.source, 'index');
  assert.deepEqual(engine.queryByRisk(s, 'r3').accounts.map((a) => a.account), ['a1']);

  // unique flag conflicts
  assert.throws(
    () => engine.commit(s, { ops: [{ op: 'insert', account: 'a4', risk: 'r2' }] }),
    (e) => e instanceof engine.DbError && e.code === 'E_DUP_RISK',
  );
  assert.throws(
    () => engine.commit(s, { ops: [{ op: 'setRisk', account: 'a2', risk: 'r3' }] }),
    (e) => e.code === 'E_DUP_RISK',
  );
  // failed tx must not advance the version
  const vBefore = s.version;
  assert.throws(() => engine.commit(s, { ops: [{ op: 'insert', account: 'a5', risk: 'r2' }] }));
  assert.equal(s.version, vBefore);

  // future versions rejected
  assert.throws(
    () => engine.queryByRisk(s, 'r1', s.version + 1),
    (e) => e.code === 'E_BAD_VERSION',
  );
});
