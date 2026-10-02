import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { begin, add, rewrite, commit, status } from '../src/daybook.js';
import { tmpdir, runCli, readState } from '../testkit/helpers.mjs';

test('normal flow: begin/add/rewrite/commit with drop+move+fix', () => {
  const dir = tmpdir();
  begin(dir, '2026-10-03');
  add(dir, { id: 'e1', account: 'cash', amount: 100 });
  add(dir, { id: 'e2', account: 'cash', amount: -40 });
  add(dir, { id: 'e3', account: 'cash', amount: -60 });

  // net cash = 0; drop e3 (-60) and fix e2 -40 -> -100 keeps net at 0; move e2 before e1
  rewrite(dir, {
    dropIds: ['e3'],
    fixAmounts: { e2: -100 },
    moveBefore: [['e2', 'e1']],
  });

  let st = status(dir);
  assert.equal(st.status, 'OPEN_OLD');
  assert.equal(st.date, '2026-10-03');
  assert.equal(st.entries, 2);
  assert.deepEqual(st.basis, ['HEAD', 'snapshot.json']);

  const day = readState(dir).days['2026-10-03'];
  assert.deepEqual(
    day.entries.map((e) => [e.id, e.amount]),
    [
      ['e2', -100],
      ['e1', 100],
    ],
  );

  commit(dir);
  st = status(dir);
  assert.equal(st.status, 'OLD_COMMITTED');
  assert.equal(st.date, '2026-10-03');
  const committed = readState(dir).days['2026-10-03'];
  assert.equal(committed.status, 'committed');
  assert.equal(readState(dir).openDate, null);
});

test('rewrite on committed day is rejected (no open day)', () => {
  const dir = tmpdir();
  begin(dir, '2026-10-03');
  add(dir, { id: 'e1', account: 'cash', amount: 5 });
  commit(dir);
  assert.throws(() => rewrite(dir, { dropIds: [] }), (e) => e.code === 'STATE_ERROR');
});

test('add validates reversal references and duplicates', () => {
  const dir = tmpdir();
  begin(dir, '2026-10-03');
  assert.throws(
    () => add(dir, { id: 'r1', account: 'cash', amount: -1, type: 'REVERSAL', reversalOf: 'nope' }),
    (e) => e.code === 'STATE_ERROR',
  );
  add(dir, { id: 'e1', account: 'cash', amount: 10 });
  assert.throws(() => add(dir, { id: 'e1', account: 'cash', amount: 1 }), (e) => e.code === 'STATE_ERROR');
});

test('cli end-to-end: begin/add/rewrite/commit/status', () => {
  const dir = tmpdir();
  assert.equal(runCli(dir, ['begin', '2026-10-03']).code, 0);
  assert.equal(runCli(dir, ['add', '{"id":"e1","account":"cash","amount":7}']).code, 0);
  assert.equal(runCli(dir, ['add', '{"id":"e2","account":"cash","amount":-7}']).code, 0);
  const planFile = `${dir}/plan.json`;
  fs.writeFileSync(planFile, JSON.stringify({ moveBefore: [['e2', 'e1']] }));
  assert.equal(runCli(dir, ['rewrite', planFile]).code, 0);
  const st = runCli(dir, ['status']);
  assert.equal(st.json.status, 'OPEN_OLD');
  assert.equal(runCli(dir, ['commit']).code, 0);
  const st2 = runCli(dir, ['status']);
  assert.equal(st2.json.status, 'OLD_COMMITTED');
  assert.deepEqual(st2.json.basis, ['HEAD', 'snapshot.json']);
});
