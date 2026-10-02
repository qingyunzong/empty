import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { begin, add, rewrite, commit, recover } from '../src/daybook.js';
import { EXIT } from '../src/store.js';
import { tmpdir, runCli } from '../testkit/helpers.mjs';

function dayWithReversal(dir) {
  begin(dir, '2026-10-03');
  add(dir, { id: 'e1', account: 'cash', amount: 100 });
  add(dir, { id: 'r1', account: 'cash', amount: -100, type: 'REVERSAL', reversalOf: 'e1' });
}

test('REVERSAL must not precede its original (move) -> PLAN_INVALID exit 22', () => {
  const dir = tmpdir();
  dayWithReversal(dir);
  assert.throws(
    () => rewrite(dir, { moveBefore: [['r1', 'e1']] }),
    (e) => e.code === 'PLAN_INVALID' && e.reason === 'REVERSAL_CAUSALITY' && e.exitCode === 22,
  );
});

test('dropping the original of a kept reversal -> PLAN_INVALID exit 22', () => {
  const dir = tmpdir();
  dayWithReversal(dir);
  assert.throws(
    () => rewrite(dir, { dropIds: ['e1'] }),
    (e) => e.code === 'PLAN_INVALID' && e.reason === 'REVERSAL_CAUSALITY' && e.exitCode === 22,
  );
});

test('dropping both original and reversal is allowed (net stays 0)', () => {
  const dir = tmpdir();
  dayWithReversal(dir);
  rewrite(dir, { dropIds: ['e1', 'r1'] });
  assert.equal(recover(dir).entries, 0);
});

test('net protection: unbalanced fixAmounts -> PLAN_INVALID exit 22', () => {
  const dir = tmpdir();
  dayWithReversal(dir);
  assert.throws(
    () => rewrite(dir, { fixAmounts: { e1: 150 } }),
    (e) => e.code === 'PLAN_INVALID' && e.reason === 'NET_CHANGED' && e.exitCode === 22,
  );
});

test('net protection: unbalanced drop -> PLAN_INVALID exit 22', () => {
  const dir = tmpdir();
  begin(dir, '2026-10-03');
  add(dir, { id: 'e1', account: 'cash', amount: 100 });
  assert.throws(
    () => rewrite(dir, { dropIds: ['e1'] }),
    (e) => e.code === 'PLAN_INVALID' && e.reason === 'NET_CHANGED' && e.exitCode === 22,
  );
});

test('balanced fixAmounts accepted', () => {
  const dir = tmpdir();
  dayWithReversal(dir);
  rewrite(dir, { fixAmounts: { e1: 150, r1: -150 } });
  assert.equal(recover(dir).status, 'OPEN_OLD');
});

test('cross-day rewrite via plan.date -> exit 21', () => {
  const dir = tmpdir();
  begin(dir, '2026-10-02');
  add(dir, { id: 'a1', account: 'cash', amount: 1 });
  commit(dir);
  begin(dir, '2026-10-03');
  add(dir, { id: 'b1', account: 'cash', amount: 2 });
  assert.throws(
    () => rewrite(dir, { date: '2026-10-02', dropIds: [] }),
    (e) => e.code === 'REWRITE_CROSS_DAY' && e.exitCode === 21,
  );
});

test('cross-day rewrite via committed entry id -> exit 21', () => {
  const dir = tmpdir();
  begin(dir, '2026-10-02');
  add(dir, { id: 'a1', account: 'cash', amount: 1 });
  commit(dir);
  begin(dir, '2026-10-03');
  add(dir, { id: 'b1', account: 'cash', amount: 2 });
  assert.throws(
    () => rewrite(dir, { fixAmounts: { a1: 5 } }),
    (e) => e.code === 'REWRITE_CROSS_DAY' && e.exitCode === 21,
  );
});

test('cli exit codes: 21 cross-day, 22 plan invalid', () => {
  const dir = tmpdir();
  runCli(dir, ['begin', '2026-10-02']);
  runCli(dir, ['add', '{"id":"a1","account":"cash","amount":1}']);
  runCli(dir, ['commit']);
  runCli(dir, ['begin', '2026-10-03']);
  runCli(dir, ['add', '{"id":"b1","account":"cash","amount":2}']);

  fs.writeFileSync(path.join(dir, 'p21.json'), JSON.stringify({ date: '2026-10-02' }));
  const r21 = runCli(dir, ['rewrite', path.join(dir, 'p21.json')]);
  assert.equal(r21.code, EXIT.CROSS_DAY);
  assert.match(r21.stderr, /REWRITE_CROSS_DAY/);

  fs.writeFileSync(path.join(dir, 'p22.json'), JSON.stringify({ dropIds: ['b1'] }));
  const r22 = runCli(dir, ['rewrite', path.join(dir, 'p22.json')]);
  assert.equal(r22.code, EXIT.PLAN_INVALID);
  assert.match(r22.stderr, /NET_CHANGED/);
});

test('recovery ambiguity: HEAD points to wal but wal.jsonl missing -> exit 23', () => {
  const dir = tmpdir();
  begin(dir, '2026-10-03');
  add(dir, { id: 'e1', account: 'cash', amount: 1 });
  // simulate a crash right after HEAD=wal, then lose the wal
  try {
    commit(dir, { faultAt: 'after-head' });
  } catch {}
  fs.unlinkSync(path.join(dir, 'wal.jsonl'));
  assert.throws(
    () => recover(dir),
    (e) => e.code === 'RECOVERY_AMBIGUOUS' && e.exitCode === 23,
  );
  const r = runCli(dir, ['recover']);
  assert.equal(r.code, EXIT.AMBIGUOUS);
  assert.match(r.stderr, /RECOVERY_AMBIGUOUS/);
});

test('recovery ambiguity: corrupt HEAD -> exit 23', () => {
  const dir = tmpdir();
  begin(dir, '2026-10-03');
  fs.writeFileSync(path.join(dir, 'HEAD'), 'garbage\n');
  assert.throws(() => recover(dir), (e) => e.code === 'RECOVERY_AMBIGUOUS' && e.exitCode === 23);
});
