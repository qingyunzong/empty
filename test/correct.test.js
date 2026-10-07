// Acceptance 3: a corrected re-inspection only diffuses to the affected sequences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir, runCli, runOk, readState } from '../test-utils/helpers.js';

test('correction impact set is incremental: only sequences >= correction point in that order', () => {
  const dir = tmpDir();
  for (const d of ['D1', 'D2', 'D3', 'D4', 'D5']) runOk(dir, ['open', d]);
  runOk(dir, ['rework', 'R1', 'D1', 'D2', 'D3', 'D4']);
  runOk(dir, ['rework', 'R2', 'D5']);
  for (const s of ['0', '1', '2', '3']) runOk(dir, ['inspect', 'R1', s, 'pass']);
  runOk(dir, ['inspect', 'R2', '0', 'pass']);

  runOk(dir, ['correct', 'R1', '1', 'fail']);

  const state = readState(dir);
  const seqs = state.orders.R1.sequences;
  assert.deepEqual(
    seqs.map((s) => [s.inspection, s.affected]),
    [['pass', false], ['fail', true], [null, true], [null, true]],
    'seq0 untouched; seq1 corrected; seq2..3 reset and flagged as the incremental impact set'
  );
  assert.deepEqual(
    state.orders.R2.sequences.map((s) => [s.inspection, s.affected]),
    [['pass', false]],
    'other orders are not touched by the correction'
  );

  const closeEarly = runCli(dir, ['close', 'R1']);
  assert.equal(closeEarly.status, 1, 'cannot close while impacted sequences are un-inspected');

  runOk(dir, ['inspect', 'R1', '1', 'pass']);
  runOk(dir, ['inspect', 'R1', '2', 'pass']);
  runOk(dir, ['inspect', 'R1', '3', 'pass']);
  runOk(dir, ['close', 'R1']);

  const final = readState(dir);
  assert.equal(final.orders.R1.status, 'closed');
  for (const d of ['D1', 'D2', 'D3', 'D4']) assert.equal(final.defects[d].status, 'closed');
  assert.equal(runCli(dir, ['verify']).status, 0);
});
