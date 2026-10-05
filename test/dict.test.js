import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archive } from '../src/archive.js';
import { Querier } from '../src/query.js';

// Acceptance 4: shared dictionary updates must not break old frozen segments.
test('old frozen segments stay decodable after dictionary update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-dict-'));
  const archive = new Archive(dir);
  archive.append({ ts: 1, device: 'd1', tokens: 'alpha beta' });
  const meta1 = archive.freeze();
  assert.equal(meta1.dictVersion, 1);
  const dictV1 = fs.readFileSync(path.join(dir, 'dict', 'dict-1.json'), 'utf8');

  archive.append({ ts: 2, device: 'd1', tokens: 'gamma alpha' }); // 'gamma' is new
  const meta2 = archive.freeze();
  assert.equal(meta2.dictVersion, 2, 'new token bumps shared dict version');
  assert.equal(fs.readFileSync(path.join(dir, 'dict', 'dict-1.json'), 'utf8'), dictV1, 'dict v1 immutable');

  const reopened = new Archive(dir);
  const seg1 = reopened.loadSegment('seg-000001');
  assert.deepEqual(seg1.events[0].tokens, ['alpha', 'beta'], 'old segment decodes via dict v1');
  const seg2 = reopened.loadSegment('seg-000002');
  assert.deepEqual(seg2.events[0].tokens, ['gamma', 'alpha']);

  const querier = new Querier(reopened);
  assert.equal(querier.phrase('alpha beta').length, 1);
  assert.equal(querier.phrase('beta gamma').length, 1, 'cross-segment phrase across dict versions');
  const stats = reopened.stats();
  assert.equal(stats.dictVersion, 2);
  assert.equal(stats.dictSize, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});
