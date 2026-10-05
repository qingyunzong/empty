import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { corr, makeTmpDir, register, remove, run, writeJsonl } from '../support/helpers.js';

// Acceptance 1: out-of-order and duplicated ingest produces identical queries.
test('shuffled and duplicated ingest yields identical query output', () => {
  const dir = makeTmpDir();
  const records = [
    register('A', 'O1', 1),
    register('B', 'O2', 1),
    corr('A', '2026-01-01T00:00:00Z', -1.5, 'O1', 2),
    corr('A', '2026-01-01T01:00:00Z', 0.5, 'O1', 3),
    corr('B', '2026-01-01T00:00:00Z', 2.5, 'O2', 2),
    corr('A', '2026-01-01T00:00:00Z', -1.0, 'O2', 3), // conflicting correction, same key
    corr('B', '2026-01-01T01:00:00Z', -0.5, 'O1', 4),
  ];
  const duplicated = [...records, ...records.slice(0, 4), records[2]];
  const shuffled = [records[5], records[1], records[6], records[0], records[3], records[4], records[2],
    records[2], records[6], records[0]];

  const f1 = writeJsonl(dir, 'a.jsonl', duplicated);
  const f2 = writeJsonl(dir, 'b.jsonl', shuffled);

  const s1 = join(dir, 's1.jsonl');
  const s2 = join(dir, 's2.jsonl');
  assert.equal(run(['ingest', s1, f1]).status, 0);
  assert.equal(run(['ingest', s2, f2]).status, 0);

  // Stores are canonically identical.
  assert.equal(readFileSync(s1, 'utf8'), readFileSync(s2, 'utf8'));

  const q1 = run(['query', s1]);
  const q2 = run(['query', s2]);
  assert.equal(q1.status, 0);
  assert.equal(q1.stdout, q2.stdout);
  assert.ok(q1.stdout.split('\n').filter(Boolean).length > 0);

  // Merging the two stores also converges to the same state.
  const merged = join(dir, 'merged.jsonl');
  assert.equal(run(['merge', merged, s1, s2]).status, 0);
  assert.equal(readFileSync(merged, 'utf8'), readFileSync(s1, 'utf8'));
  assert.equal(run(['query', merged]).stdout, q1.stdout);
});

// Acceptance 2: out-of-range correction is flagged invalid, kept as evidence,
// never silently dropped; default query filters it.
test('out-of-range correction goes to invalid, not silently dropped', () => {
  const dir = makeTmpDir();
  const store = join(dir, 's.jsonl');
  const setup = writeJsonl(dir, 'setup.jsonl', [
    register('A', 'O1', 1),
    corr('A', '2026-01-01T00:00:00Z', 35, 'O1', 2),   // out of range -> invalid
    corr('A', '2026-01-01T01:00:00Z', -2.5, 'O1', 3), // valid negative correction
  ]);
  const res = run(['ingest', store, setup]);
  assert.equal(res.status, 0, res.stderr);

  // Default query: only the valid correction is visible.
  const q = run(['query', store]);
  assert.equal(q.status, 0);
  const rows = q.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, -2.5);

  // Evidence mode: the invalid correction is still there, flagged.
  const qa = run(['query', store, '--include-invalid']);
  const all = qa.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(all.length, 2);
  const bad = all.find((r) => r.delta === 35);
  assert.ok(bad, 'out-of-range correction must be retained as evidence');
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'out_of_range');
});

// Acceptance 3: a tombstone prevents a deleted site from resurrecting.
test('tombstone blocks resurrection of a deleted site', () => {
  const dir = makeTmpDir();
  const store = join(dir, 's.jsonl');
  const alive = writeJsonl(dir, 'alive.jsonl', [
    register('A', 'O1', 1),
    corr('A', '2026-01-01T00:00:00Z', 1.5, 'O1', 2),
  ]);
  assert.equal(run(['ingest', store, alive]).status, 0);

  const tombstone = writeJsonl(dir, 'tombstone.jsonl', [remove('A', 'O1', 3)]);
  assert.equal(run(['ingest', store, tombstone]).status, 0);

  // Direct ingest of a correction for the deleted site fails with TOMBSTONE_HIT.
  const late = writeJsonl(dir, 'late.jsonl', [corr('A', '2026-01-02T00:00:00Z', 9, 'O1', 4)]);
  const res = run(['ingest', store, late]);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /TOMBSTONE_HIT/);

  // Merging a stale backup that still contains the site's corrections must
  // not resurrect it in the default (visible) query.
  const backup = writeJsonl(dir, 'backup.jsonl', [
    register('A', 'O1', 1),
    corr('A', '2026-01-01T00:00:00Z', 1.5, 'O1', 2),
    corr('A', '2026-01-03T00:00:00Z', 3, 'O1', 5),
  ]);
  const merged = join(dir, 'merged.jsonl');
  assert.equal(run(['merge', merged, store, backup]).status, 0);
  const q = run(['query', merged]);
  assert.equal(q.stdout.trim(), '', 'tombstoned site must stay hidden');

  // Evidence is still retained.
  const qa = run(['query', merged, '--include-invalid']);
  const all = qa.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(all.length >= 1);
  assert.ok(all.every((r) => r.valid === false && r.reason === 'tombstoned_site'));
});

// Acceptance 4: compact preserves visible query results, and only runs on
// keys covered by the minimum frontier vector.
test('compact keeps visible queries equivalent and requires min-vector coverage', () => {
  const dir = makeTmpDir();
  const store = join(dir, 's.jsonl');
  const setup = writeJsonl(dir, 'setup.jsonl', [
    register('A', 'O1', 1),
    register('B', 'O2', 1),
    // Key 1: three competing corrections (two losers to be compacted away).
    corr('A', '2026-01-01T00:00:00Z', 1.0, 'O1', 2),
    corr('A', '2026-01-01T00:00:00Z', 1.5, 'O1', 3),
    corr('A', '2026-01-01T00:00:00Z', 2.0, 'O2', 2),
    // Key 2: invalid winner, kept as evidence.
    corr('A', '2026-01-01T01:00:00Z', 99, 'O2', 3),
    // Key 3: single valid correction.
    corr('B', '2026-01-01T00:00:00Z', -0.5, 'O1', 4),
  ]);
  assert.equal(run(['ingest', store, setup]).status, 0);

  const before = run(['query', store]).stdout;
  const beforeAll = run(['query', store, '--include-invalid']).stdout;
  assert.ok(before.trim().length > 0);

  // Without frontier records nothing is covered: compact is a no-op.
  const untouched = join(dir, 'untouched.jsonl');
  assert.equal(run(['compact', store, '--out', untouched]).status, 0);
  assert.equal(readFileSync(untouched, 'utf8'), readFileSync(store, 'utf8'));

  // Declare replica frontiers covering every vector in the store.
  const frontiers = writeJsonl(dir, 'frontiers.jsonl', [
    { type: 'frontier', origin: 'O1', vector: { O1: 4, O2: 3 } },
    { type: 'frontier', origin: 'O2', vector: { O1: 4, O2: 3 } },
  ]);
  assert.equal(run(['ingest', store, frontiers]).status, 0);

  const linesBefore = readFileSync(store, 'utf8').trim().split('\n').length;
  assert.equal(run(['compact', store]).status, 0);
  const linesAfter = readFileSync(store, 'utf8').trim().split('\n').length;
  assert.ok(linesAfter < linesBefore, 'compact must drop superseded records');

  // Visible queries are equivalent before and after compact.
  assert.equal(run(['query', store]).stdout, before);
  assert.equal(run(['query', store, '--include-invalid']).stdout, beforeAll);

  // Tombstones survive compact: site deletion still blocks resurrection.
  const tombstone = writeJsonl(dir, 'tombstone.jsonl', [remove('B', 'O2', 5)]);
  assert.equal(run(['ingest', store, tombstone]).status, 0);
  assert.equal(run(['compact', store]).status, 0);
  const revive = writeJsonl(dir, 'revive.jsonl', [corr('B', '2026-01-02T00:00:00Z', 1, 'O1', 6)]);
  const res = run(['ingest', store, revive]);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /TOMBSTONE_HIT/);
});
