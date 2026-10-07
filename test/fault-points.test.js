// Acceptance 1: the three fixed fault-injection points produce explicit recovery results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, runCli, runOk, readState } from '../test-utils/helpers.js';

test('fault point wal-append: crash after WAL append before fsync -> recovery replays WAL', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1', 'ok-one']);
  const crash = runCli(dir, ['open', 'D2', 'lost-fsync'], { QC_CRASH_AT: 'wal-append' });
  assert.equal(crash.status, 2, 'process must die at the fault point');

  const rec = runOk(dir, ['crash-recover']);
  assert.equal(rec.recovery.replayedRecords >= 1, true, 'WAL tail must be replayed');
  assert.equal(rec.recovery.replayedFromSeq, 1);

  const state = readState(dir);
  assert.equal(state.defects.D2.status, 'open', 'appended-but-not-fsynced record is recovered by WAL replay');
  assert.equal(state.lastSeq, 2);
  assert.equal(runCli(dir, ['verify']).status, 0);
});

test('fault point snapshot-rename: crash before rename -> half snapshot ignored', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1']);
  const crash = runCli(dir, ['open', 'D2'], { QC_CRASH_AT: 'snapshot-rename' });
  assert.equal(crash.status, 2);
  assert.equal(fs.existsSync(path.join(dir, 'snapshot.json.tmp')), true, 'half snapshot left behind');

  const rec = runOk(dir, ['crash-recover']);
  assert.equal(rec.recovery.ignoredHalfSnapshot, true, 'half snapshot must be reported as ignored');
  assert.equal(fs.existsSync(path.join(dir, 'snapshot.json.tmp')), false, 'half snapshot cleaned up');

  const state = readState(dir);
  assert.deepEqual(Object.keys(state.defects).sort(), ['D1', 'D2'], 'both ops present via snapshot + WAL replay');
  assert.equal(runCli(dir, ['verify']).status, 0);
});

test('fault point index-update: crash after index update -> index rebuilt without double counting', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1']);
  runOk(dir, ['open', 'D2']);
  const crash = runCli(dir, ['open', 'D3'], { QC_CRASH_AT: 'index-update' });
  assert.equal(crash.status, 2);

  const rec = runOk(dir, ['crash-recover']);
  assert.equal(rec.recovery.rebuiltIndex, true);
  const index1 = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index1.opsApplied, 3);
  assert.equal(index1.defectsOpen, 3);

  runOk(dir, ['crash-recover']);
  const index2 = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(index2, index1, 'repeated recovery must not double-count');
  assert.equal(runCli(dir, ['verify']).status, 0);
});
