// Acceptance 2: a crash halfway through the scan (before the watermark write)
// is recovered on restart; the resumed backfill completes and never registers
// the same (riskFlag, account) pair twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDir, ok, run, seedAccounts } from '../test-support/util.js';

test('crash mid-backfill, restart resumes without duplicate registration', async () => {
  const dir = makeDir();
  await seedAccounts(dir, 8);

  const crash = await run(dir, ['crash', '--backfill']);
  assert.notEqual(crash.code, 0, 'simulated crash must exit non-zero');
  assert.equal(crash.errJson.error.code, 'E_CRASH');

  const mid = await ok(dir, 'status');
  assert.equal(mid.index.state, 'building');
  assert.equal(mid.index.watermark, null);
  assert.ok(mid.backfill.cursor > 0 && mid.backfill.cursor < mid.backfill.total,
    `cursor ${mid.backfill.cursor} should be halfway through ${mid.backfill.total}`);

  // Restart: stale lock from the crashed process is reclaimed, backfill resumes.
  await ok(dir, 'build-index', '--batch', '2');

  const st = await ok(dir, 'status');
  assert.equal(st.index.state, 'ready');
  assert.equal(st.backfill, null);
  assert.equal(st.index.openRanges, 8, 'exactly one open range per flagged account');
  assert.equal(st.index.keys, 8, 'no duplicate (riskFlag, account) keys');

  for (const risk of ['R0', 'R1', 'R2']) {
    const viaIndex = await ok(dir, 'query', '--risk', risk);
    const viaScan = await ok(dir, 'query', '--risk', risk, '--scan');
    assert.equal(viaIndex.source, 'index');
    assert.deepEqual(viaIndex.accounts, viaScan.accounts, `risk ${risk}`);
  }

  // Rebuilding a ready index is a no-op and stays consistent.
  const again = await ok(dir, 'build-index');
  assert.equal(again.index.state, 'ready');
  assert.equal(again.index.keys, 8);
});
