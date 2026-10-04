// End-to-end CLI tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

function run(args, { expectFail = false } = {}) {
  const lines = [];
  const code = main(args, { write: (s) => lines.push(s) });
  const out = JSON.parse(lines[lines.length - 1]);
  if (expectFail) {
    assert.notEqual(code, 0, `expected non-zero exit, got ${JSON.stringify(out)}`);
  } else {
    assert.equal(code, 0, `expected zero exit, got ${JSON.stringify(out)}`);
  }
  return out;
}

function writeJsonl(dir, name, events) {
  const p = join(dir, name);
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

test('CLI: ingest -> equiv -> merge -> snapshot -> restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftlog-cli-'));
  const store = join(dir, 'store.snap');
  const f1 = writeJsonl(dir, 's1.jsonl', [
    { id: 'a', causes: [] },
    { id: 'b', causes: ['a'] },
    { id: 'c', causes: ['b'] },
  ]);
  const f2 = writeJsonl(dir, 's2.jsonl', [
    { id: 'c', causes: ['b'] },
    { id: 'a', causes: [] },
    { id: 'b', causes: ['a'] },
  ]);
  const f3 = writeJsonl(dir, 's3.jsonl', [
    { id: 'a', causes: [] },
    { id: 'b', causes: [] }, // missing a->b
    { id: 'c', causes: ['b'] },
  ]);

  assert.equal(run(['ingest', store, 's1', f1]).status, 'OK');
  assert.equal(run(['ingest', store, 's2', f2]).status, 'OK');
  assert.equal(run(['ingest', store, 's3', f3]).status, 'OK');

  // duplicate log_id rejected
  const dup = run(['ingest', store, 's1', f1], { expectFail: true });
  assert.equal(dup.status, 'INVALID_INPUT');

  assert.equal(run(['equiv', store, 's1', 's2']).status, 'EQUAL');

  const und = run(['equiv', store, 's1', 's3']);
  assert.equal(und.status, 'UNDECIDED');
  assert.ok(und.missing_edges.some((e) => e.from === 'a' && e.to === 'b'));

  const exp = run(['explain', store, 's1', 's3']);
  assert.equal(exp.status, 'UNDECIDED');
  assert.ok(exp.counts.shared === 3);

  const merged = run(['merge', store, 's1', 's2', 's12']);
  assert.equal(merged.status, 'OK');
  assert.equal(run(['equiv', store, 's1', 's12']).status, 'EQUAL');

  const out = join(dir, 'export.snap');
  assert.equal(run(['snapshot', store, out]).status, 'OK');
  assert.equal(run(['restore', out]).status, 'OK');

  // truncated snapshot via CLI
  const trunc = join(dir, 'trunc.snap');
  writeFileSync(trunc, readFileSync(out, 'utf8').slice(0, 40));
  const bad = run(['restore', trunc], { expectFail: true });
  assert.equal(bad.status, 'RESTORE_CORRUPT');

  // store still valid after all the failed operations
  assert.equal(run(['equiv', store, 's1', 's2']).status, 'EQUAL');
});

test('CLI: NOT_EQUAL reports first_divergent and minimal_frontier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftlog-cli-'));
  const store = join(dir, 'store.snap');
  const f1 = writeJsonl(dir, 'x.jsonl', [
    { id: 'p', causes: [] },
    { id: 'q', causes: [] },
    { id: 'r', causes: ['p'] },
  ]);
  const f2 = writeJsonl(dir, 'y.jsonl', [
    { id: 'p', causes: [] },
    { id: 'q', causes: [] },
    { id: 'r', causes: ['q'] },
  ]);
  run(['ingest', store, 'x', f1]);
  run(['ingest', store, 'y', f2]);
  const r = run(['equiv', store, 'x', 'y']);
  assert.equal(r.status, 'NOT_EQUAL');
  assert.equal(r.first_divergent, 'r');
  assert.deepEqual(r.minimal_frontier, [
    { from: 'p', to: 'r', only_in: 'a' },
    { from: 'q', to: 'r', only_in: 'b' },
  ]);
});

test('CLI: invalid JSONL and usage errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftlog-cli-'));
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{"id":"a"}\nnot json\n');
  const r = run(['ingest', join(dir, 's.snap'), 'log', bad], { expectFail: true });
  assert.equal(r.status, 'INVALID_INPUT');
});
