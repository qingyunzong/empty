import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { corr, makeTmpDir, register, remove, run, writeJsonl } from '../support/helpers.js';

test('BAD_RANGE: non-finite delta', () => {
  const dir = makeTmpDir();
  const store = join(dir, 's.jsonl');
  const setup = writeJsonl(dir, 'setup.jsonl', [register('A', 'O1', 1)]);
  assert.equal(run(['ingest', store, setup]).status, 0);
  const bad = writeJsonl(dir, 'bad.jsonl', [
    '{"type":"correction","site":"A","time":"2026-01-01T00:00:00Z","delta":1e999,"origin":"O1","seq":2}',
  ]);
  const res = run(['ingest', store, bad]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /BAD_RANGE/);
});

test('BAD_RANGE: invalid timestamp and inverted query range', () => {
  const dir = makeTmpDir();
  const store = join(dir, 's.jsonl');
  const setup = writeJsonl(dir, 'setup.jsonl', [register('A', 'O1', 1)]);
  assert.equal(run(['ingest', store, setup]).status, 0);

  const badTime = writeJsonl(dir, 'badtime.jsonl', [corr('A', 'not-a-time', 1, 'O1', 2)]);
  const res1 = run(['ingest', store, badTime]);
  assert.equal(res1.status, 2);
  assert.match(res1.stderr, /BAD_RANGE/);

  const res2 = run(['query', store, '--from', '2026-02-01', '--to', '2026-01-01']);
  assert.equal(res2.status, 2);
  assert.match(res2.stderr, /BAD_RANGE/);
});

test('UNKNOWN_SITE: correction or delete for unregistered site', () => {
  const dir = makeTmpDir();
  const store = join(dir, 's.jsonl');
  const f = writeJsonl(dir, 'f.jsonl', [corr('GHOST', '2026-01-01T00:00:00Z', 1, 'O1', 1)]);
  const res = run(['ingest', store, f]);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /UNKNOWN_SITE/);

  const d = writeJsonl(dir, 'd.jsonl', [remove('GHOST', 'O1', 1)]);
  const res2 = run(['ingest', store, d]);
  assert.equal(res2.status, 3);
  assert.match(res2.stderr, /UNKNOWN_SITE/);
});

test('TOMBSTONE_HIT: ingest correction for deleted site', () => {
  const dir = makeTmpDir();
  const store = join(dir, 's.jsonl');
  const setup = writeJsonl(dir, 'setup.jsonl', [
    register('A', 'O1', 1),
    corr('A', '2026-01-01T00:00:00Z', 1, 'O1', 2),
  ]);
  assert.equal(run(['ingest', store, setup]).status, 0);
  const tombstone = writeJsonl(dir, 'tombstone.jsonl', [remove('A', 'O1', 3)]);
  assert.equal(run(['ingest', store, tombstone]).status, 0);
  const late = writeJsonl(dir, 'late.jsonl', [corr('A', '2026-01-02T00:00:00Z', 2, 'O1', 4)]);
  const res = run(['ingest', store, late]);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /TOMBSTONE_HIT/);
});

test('negative corrections are valid and visible by default', () => {
  const dir = makeTmpDir();
  const store = join(dir, 's.jsonl');
  const setup = writeJsonl(dir, 'setup.jsonl', [
    register('A', 'O1', 1),
    corr('A', '2026-01-01T00:00:00Z', -19.9, 'O1', 2),
  ]);
  assert.equal(run(['ingest', store, setup]).status, 0);
  const q = run(['query', store]);
  const rows = q.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, -19.9);
});
