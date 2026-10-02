import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { begin, add, rewrite, commit, recover, status } from '../src/daybook.js';
import { FAULT_POINTS, FaultInjected } from '../src/store.js';
import { tmpdir, runCli, readState } from '../testkit/helpers.mjs';

function openDayWithEntries(dir) {
  begin(dir, '2026-10-03');
  add(dir, { id: 'e1', account: 'cash', amount: 100 });
  add(dir, { id: 'e2', account: 'cash', amount: -100 });
}

for (const point of FAULT_POINTS) {
  test(`commit crash at ${point}: recover is deterministic`, () => {
    const dir = tmpdir();
    openDayWithEntries(dir);

    assert.throws(() => commit(dir, { faultAt: point }), (e) => e instanceof FaultInjected);

    const r1 = recover(dir);
    if (point === 'after-head') {
      // HEAD=wal was durable -> the commit won
      assert.equal(r1.status, 'COMMITTED_NEW');
      assert.deepEqual(r1.basis, ['HEAD', 'wal.jsonl']);
      assert.equal(readState(dir).days['2026-10-03'].status, 'committed');
    } else {
      // wal never became authoritative -> commit lost, day still open with old entries
      assert.equal(r1.status, 'OPEN_OLD');
      assert.deepEqual(r1.basis, ['HEAD', 'snapshot.json']);
      const day = readState(dir).days['2026-10-03'];
      assert.equal(day.status, 'open');
      assert.deepEqual(day.entries.map((e) => e.id), ['e1', 'e2']);
    }

    // recovery is idempotent and converges to a stable status
    const r2 = recover(dir);
    assert.equal(r2.status, point === 'after-head' ? 'OLD_COMMITTED' : 'OPEN_OLD');
    assert.equal(status(dir).status, r2.status);

    // no leftover staging artifacts
    assert.equal(fs.existsSync(path.join(dir, 'wal.jsonl.tmp')), false);
    assert.equal(fs.existsSync(path.join(dir, 'wal.jsonl')), false);

    if (point !== 'after-head') {
      // the lost commit can simply be retried
      commit(dir);
      assert.equal(status(dir).status, 'OLD_COMMITTED');
    }
  });

  test(`rewrite crash at ${point}: recover is deterministic`, () => {
    const dir = tmpdir();
    openDayWithEntries(dir);
    add(dir, { id: 'e3', account: 'fee', amount: 5 });
    add(dir, { id: 'e4', account: 'fee', amount: -5 });

    const plan = { moveBefore: [['e4', 'e1']], fixAmounts: { e3: 3, e4: -3 } };
    assert.throws(() => rewrite(dir, plan, { faultAt: point }), (e) => e instanceof FaultInjected);

    const r = recover(dir);
    const day = readState(dir).days['2026-10-03'];
    if (point === 'after-head') {
      assert.equal(r.status, 'OPEN_NEW');
      assert.deepEqual(
        day.entries.map((e) => [e.id, e.amount]),
        [
          ['e4', -3],
          ['e1', 100],
          ['e2', -100],
          ['e3', 3],
        ],
      );
    } else {
      assert.equal(r.status, 'OPEN_OLD');
      assert.deepEqual(
        day.entries.map((e) => [e.id, e.amount]),
        [
          ['e1', 100],
          ['e2', -100],
          ['e3', 5],
          ['e4', -5],
        ],
      );
    }
    // day is still open either way and can be committed afterwards
    commit(dir);
    assert.equal(status(dir).status, 'OLD_COMMITTED');
  });
}

test('cli: fault injection via DAYBOOK_FAULT_AT then recover', () => {
  const dir = tmpdir();
  assert.equal(runCli(dir, ['begin', '2026-10-03']).code, 0);
  assert.equal(runCli(dir, ['add', '{"id":"e1","account":"cash","amount":9}']).code, 0);

  const crashed = runCli(dir, ['commit'], { DAYBOOK_FAULT_AT: 'before-rename' });
  assert.equal(crashed.code, 70);
  assert.match(crashed.stderr, /FAULT_INJECTED before-rename/);

  const rec = runCli(dir, ['recover']);
  assert.equal(rec.code, 0);
  assert.equal(rec.json.status, 'OPEN_OLD');

  const crashed2 = runCli(dir, ['commit'], { DAYBOOK_FAULT_AT: 'after-head' });
  assert.equal(crashed2.code, 70);
  const rec2 = runCli(dir, ['recover']);
  assert.equal(rec2.json.status, 'COMMITTED_NEW');
  const st = runCli(dir, ['status']);
  assert.equal(st.json.status, 'OLD_COMMITTED');
});
