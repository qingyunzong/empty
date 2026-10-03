import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay } from '../src/cli.js';

const SAMPLE = [
  { op: 'observe', id: 'f1', ts: 10, node: 'welder-1' },
  { op: 'observe', id: 'f2', ts: 20, node: 'welder-1' },
  { op: 'observe', id: 'alarm1', ts: 30, node: 'cell-a' },
  { op: 'observe', id: 'alarm2', ts: 30, node: 'cell-b' },
  { op: 'link', a: 'f1', b: 'f2', kind: 'causes' },
  { op: 'link', a: 'f2', b: 'alarm1', kind: 'causes' },
  { op: 'checkpoint' },
  { op: 'query', a: 'f1', b: 'alarm1' },
  { op: 'query', a: 'alarm1', b: 'alarm2' },
  { op: 'query', a: 'alarm2', b: 'f1' },
  { op: 'link', a: 'alarm1', b: 'alarm2' },
  { op: 'link', a: 'alarm2', b: 'alarm1' },
  { op: 'scc' },
  { op: 'rollback', k: 1 },
  { op: 'scc' },
  { op: 'rollback', k: 5 },
  { op: 'rollback', k: -2 },
  { op: 'observe', id: 'f1', ts: 99, node: 'welder-1' },
  { op: 'link', a: 'f1', b: 'ghost' },
  'this is not json',
].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');

test('cli: JSONL replay produces per-line results and coded errors', () => {
  const results = replay(SAMPLE);
  const byLine = new Map(results.map((r) => [r.line, r]));

  assert.deepEqual(byLine.get(8), { line: 8, op: 'query', ok: true, result: 'REACHABLE' });
  assert.deepEqual(byLine.get(9), { line: 9, op: 'query', ok: true, result: 'CONCURRENT' });
  assert.deepEqual(byLine.get(10), { line: 10, op: 'query', ok: true, result: 'UNDECIDED' });
  assert.deepEqual(byLine.get(13), { line: 13, op: 'scc', ok: true, components: [['alarm1', 'alarm2']] });
  // rollback(1) undoes the two links added after the checkpoint.
  assert.deepEqual(byLine.get(15), { line: 15, op: 'scc', ok: true, components: [] });
  assert.equal(byLine.get(16).error, 'ROLLBACK_RANGE');
  assert.equal(byLine.get(16).ok, false);
  assert.equal(byLine.get(17).error, 'INVALID_INPUT'); // negative k
  assert.equal(byLine.get(18).error, 'INVALID_INPUT'); // duplicate id
  assert.equal(byLine.get(19).error, 'INVALID_INPUT'); // missing endpoint
  assert.equal(byLine.get(20).error, 'INVALID_INPUT'); // malformed JSON
  assert.equal(byLine.get(20).op, null);
});

test('cli: bundled example replay.jsonl produces expected causal analysis', () => {
  const input = readFileSync(new URL('../examples/replay.jsonl', import.meta.url), 'utf8');
  const results = replay(input);
  const byLine = new Map(results.map((r) => [r.line, r]));
  // fault-7 -> temp-spike -> alarm-a: the alarm is causally explained.
  assert.equal(byLine.get(8).result, 'REACHABLE');
  // alarm-a and alarm-b share a physical moment, no causal link: concurrent.
  assert.equal(byLine.get(9).result, 'CONCURRENT');
  // alarm-b vs fault-7: different moments, no evidence either way: undecided.
  assert.equal(byLine.get(10).result, 'UNDECIDED');
  assert.deepEqual(byLine.get(11).components, []);
  // rollback(1) undoes everything after the checkpoint: links are gone.
  assert.equal(byLine.get(13).result, 'UNDECIDED');
});
