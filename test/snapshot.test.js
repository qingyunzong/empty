// Acceptance 3: old snapshots only see the data visible at their version,
// unaffected by post-backfill changes; duplicate risk-flag registration is
// rejected with E_DUP_RISK; errors are JSON with non-zero exit codes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDir, ok, fail, tx } from '../test-support/util.js';

test('snapshot isolation, index visibility windows, and E_DUP_RISK', async () => {
  const dir = makeDir();

  await tx(dir, [
    { op: 'insert', account: 'A', amount: 100 },
    { op: 'insert', account: 'B', amount: 100 },
    { op: 'risk', account: 'A', flag: 'R1' },
    { op: 'risk', account: 'B', flag: 'R1' },
  ]);
  const vOld = (await ok(dir, 'status')).version;

  await tx(dir, [
    { op: 'insert', account: 'C', amount: 50 },
    { op: 'risk', account: 'C', flag: 'R2' },
  ]);
  await tx(dir, [{ op: 'risk', account: 'A', flag: 'R2' }]); // A moves R1 -> R2
  await tx(dir, [
    { op: 'insert', account: 'D', amount: 50 },
    { op: 'risk', account: 'D', flag: 'R1' },
  ]);

  await ok(dir, 'build-index');
  const afterBuild = await ok(dir, 'status');
  assert.equal(afterBuild.index.state, 'ready');
  assert.ok(vOld < afterBuild.index.watermark, 'old snapshot predates the watermark');

  // Post-backfill change must not leak into old snapshots.
  await tx(dir, [
    { op: 'insert', account: 'E', amount: 50 },
    { op: 'risk', account: 'E', flag: 'R1' },
  ]);

  const oldSnap = await ok(dir, 'query', '--risk', 'R1', '--at', String(vOld));
  assert.equal(oldSnap.source, 'scan');
  assert.deepEqual(oldSnap.accounts, ['A', 'B']);

  // Index path at the watermark version: sees B and D but not E (E came later).
  const atWatermark = await ok(dir, 'query', '--risk', 'R1', '--at', String(afterBuild.index.watermark));
  assert.equal(atWatermark.source, 'index');
  assert.deepEqual(atWatermark.accounts, ['B', 'D']);

  // Latest query via index matches the scan reference.
  const latest = await ok(dir, 'query', '--risk', 'R1');
  assert.equal(latest.source, 'index');
  assert.deepEqual(latest.accounts, ['B', 'D', 'E']);
  assert.deepEqual(latest.accounts, (await ok(dir, 'query', '--risk', 'R1', '--scan')).accounts);

  // R2 via index at latest: A and C.
  assert.deepEqual((await ok(dir, 'query', '--risk', 'R2')).accounts, ['A', 'C']);

  // Unique flag conflict -> E_DUP_RISK as JSON on stderr, non-zero exit.
  const dup = await fail(dir, 'tx', JSON.stringify({ ops: [{ op: 'risk', account: 'A', flag: 'R2' }] }));
  assert.equal(dup.code, 'E_DUP_RISK');

  // Error surface: malformed JSON, bad version, unknown account, unknown command.
  assert.equal((await fail(dir, 'tx', 'not json')).code, 'E_BAD_JSON');
  assert.equal((await fail(dir, 'query', '--risk', 'R1', '--at', '999')).code, 'E_BAD_VERSION');
  assert.equal((await fail(dir, 'tx', JSON.stringify({ ops: [{ op: 'pay', account: 'ZZ', id: 'x', amount: 1 }] }))).code, 'E_NO_ACCOUNT');
  assert.equal((await fail(dir, 'bogus-command')).code, 'E_USAGE');
});
