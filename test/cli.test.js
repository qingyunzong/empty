import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, EXIT_CODES } from '../cli.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'shiftlog-'));
  const store = join(dir, 'store.json');
  const f1 = join(dir, 's1.jsonl');
  const f2 = join(dir, 's2.jsonl');
  writeFileSync(f1, '{"id":"e1"}\n{"id":"e2","preds":["e1"]}\n{"id":"e3","preds":["e2"]}\n');
  // same partial order, different line order + redundant transitive edge
  writeFileSync(f2, '{"id":"e3","preds":["e2","e1"]}\n{"id":"e1"}\n{"id":"e2","preds":["e1"]}\n');
  return { dir, store, f1, f2 };
}

test('CLI: ingest + equiv EQUAL (exit 0)', () => {
  const { store, f1, f2 } = setup();
  let r = runCli(['ingest', store, 's1', f1]);
  assert.equal(r.status, 'OK');
  assert.equal(EXIT_CODES[r.status], 0);
  r = runCli(['ingest', store, 's2', f2]);
  assert.equal(r.status, 'OK');
  r = runCli(['equiv', store, 's1', 's2']);
  assert.equal(r.status, 'EQUAL');
  assert.equal(EXIT_CODES[r.status], 0);
});

test('CLI: duplicate log_id -> INVALID_INPUT (exit 3)', () => {
  const { store, f1 } = setup();
  runCli(['ingest', store, 's1', f1]);
  const r = runCli(['ingest', store, 's1', f1]);
  assert.equal(r.status, 'INVALID_INPUT');
  assert.equal(EXIT_CODES[r.status], 3);
});

test('CLI: merge + explain', () => {
  const { dir, store, f1 } = setup();
  runCli(['ingest', store, 's1', f1]);
  const f3 = join(dir, 's3.jsonl');
  writeFileSync(f3, '{"id":"e4","preds":["e3"]}\n');
  runCli(['ingest', store, 's3', f3]);
  let r = runCli(['merge', store, 'handover', 's1', 's3']);
  assert.equal(r.status, 'OK');
  assert.equal(r.events, 4);
  r = runCli(['explain', store, 'handover', 's1']);
  assert.equal(r.status, 'UNDECIDED'); // s1 is a prefix of the merged log
  assert.ok(r.boundary_a.sinks.some((k) => k.includes('e4')));
});

test('CLI: snapshot + restore round-trip; truncated snapshot -> RESTORE_CORRUPT, store untouched', () => {
  const { dir, store, f1, f2 } = setup();
  runCli(['ingest', store, 's1', f1]);
  runCli(['ingest', store, 's2', f2]);
  const snap = join(dir, 'snap.json');
  let r = runCli(['snapshot', store, snap]);
  assert.equal(r.status, 'OK');

  const store2 = join(dir, 'store2.json');
  r = runCli(['restore', store2, snap]);
  assert.equal(r.status, 'OK');
  r = runCli(['equiv', store2, 's1', 's2']);
  assert.equal(r.status, 'EQUAL');

  const full = readFileSync(snap, 'utf8');
  const bad = join(dir, 'snap-bad.json');
  writeFileSync(bad, full.slice(0, full.length - 20));
  const before = readFileSync(store2, 'utf8');
  r = runCli(['restore', store2, bad]);
  assert.equal(r.status, 'RESTORE_CORRUPT');
  assert.equal(EXIT_CODES[r.status], 4);
  assert.equal(readFileSync(store2, 'utf8'), before); // store file untouched
});

test('CLI: NOT_EQUAL exit 1 / UNDECIDED exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftlog-'));
  const store = join(dir, 'store.json');
  const fa = join(dir, 'a.jsonl');
  const fb = join(dir, 'b.jsonl');
  writeFileSync(fa, '{"id":"x"}\n{"id":"y","preds":["x"]}\n');
  writeFileSync(fb, '{"id":"y"}\n{"id":"x","preds":["y"]}\n');
  runCli(['ingest', store, 'a', fa]);
  runCli(['ingest', store, 'b', fb]);
  let r = runCli(['equiv', store, 'a', 'b']);
  assert.equal(r.status, 'NOT_EQUAL');
  assert.equal(EXIT_CODES[r.status], 1);
  assert.ok(r.first_divergent);
  assert.ok(Array.isArray(r.minimal_frontier));

  const fc = join(dir, 'c.jsonl');
  writeFileSync(fc, '{"id":"x"}\n{"id":"y"}\n'); // missing edge x->y
  runCli(['ingest', store, 'c', fc]);
  r = runCli(['equiv', store, 'a', 'c']);
  assert.equal(r.status, 'UNDECIDED');
  assert.equal(EXIT_CODES[r.status], 2);
  assert.ok(r.missing_edges.some((e) => e.from === 'x' && e.to === 'y'));
});

test('CLI: invalid JSONL line -> INVALID_INPUT with line number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftlog-'));
  const store = join(dir, 'store.json');
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{"id":"x"}\n{not json}\n');
  const r = runCli(['ingest', store, 'a', bad]);
  assert.equal(r.status, 'INVALID_INPUT');
  assert.match(r.error, /line 2/);
});

test('CLI: unknown command / missing store -> INVALID_INPUT', () => {
  assert.equal(runCli(['frobnicate']).status, 'INVALID_INPUT');
  assert.equal(runCli(['equiv', '/nonexistent/store.json', 'a', 'b']).status, 'INVALID_INPUT');
});
