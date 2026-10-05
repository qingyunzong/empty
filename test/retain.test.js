import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archive, ArchiveError } from '../src/archive.js';
import { Querier } from '../src/query.js';

// Acceptance 3: retention boundary — ts == cutoff kept, ts == cutoff - 1 dropped.
test('retain boundary: ts == cutoff is kept, ts < cutoff is tombstoned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-retain-'));
  const archive = new Archive(dir);
  archive.append({ ts: 9, device: 'd1', tokens: 'old event' });
  archive.append({ ts: 10, device: 'd1', tokens: 'boundary event' });
  archive.append({ ts: 11, device: 'd1', tokens: 'new event' });
  archive.freeze();
  archive.retain(10);

  const querier = new Querier(new Archive(dir));
  assert.equal(querier.phrase('old').length, 0, 'ts=9 (< cutoff) must be dropped');
  assert.equal(querier.phrase('boundary').length, 1, 'ts=10 (== cutoff) must be kept');
  assert.equal(querier.phrase('new').length, 1, 'ts=11 (> cutoff) must be kept');
  const stats = new Archive(dir).stats();
  assert.equal(stats.tombstoneCutoff, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retain drops tombstoned active events and rejects bad windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-retain2-'));
  const archive = new Archive(dir);
  archive.append({ ts: 1, device: 'd1', tokens: 'stale' });
  archive.append({ ts: 2, device: 'd1', tokens: 'fresh' });
  archive.retain(2);
  assert.equal(archive.activeEvents.length, 1, 'tombstoned active event removed');
  assert.equal(new Querier(new Archive(dir)).phrase('stale').length, 0);
  assert.equal(new Querier(new Archive(dir)).phrase('fresh').length, 1);
  assert.throws(() => archive.retain(2), (e) => e.code === 'E_RETAIN');
  assert.throws(() => archive.retain(1), (e) => e.code === 'E_RETAIN');
  assert.throws(() => archive.retain(NaN), (e) => e.code === 'E_RETAIN');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge physically drops tombstoned events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-retain3-'));
  const archive = new Archive(dir);
  archive.append({ ts: 1, device: 'd1', tokens: 'gone soon' });
  archive.freeze();
  archive.append({ ts: 2, device: 'd1', tokens: 'kept forever' });
  archive.freeze();
  archive.retain(2);
  archive.merge(1, 2);
  const seg = archive.loadSegment(archive.manifest.frozen[0]);
  assert.equal(seg.events.length, 1);
  assert.equal(seg.events[0].tokens.join(' '), 'kept forever');
  fs.rmSync(dir, { recursive: true, force: true });
});
