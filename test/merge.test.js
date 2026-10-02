import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeHistories, foldOrder, InvalidHistory } from '../src/index.js';
import { CONFIG, hist } from './helpers.js';

const ex = (name) => ({ name, text: readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8') });
const config = JSON.parse(readFileSync(new URL('../examples/config.json', import.meta.url), 'utf8'));

test('acceptance 1: three-device merge matches a legal serialization', () => {
  const r = mergeHistories([ex('devA.jsonl'), ex('devB.jsonl'), ex('devC.jsonl')], config);
  assert.equal(r.verdict, 'CONCURRENT_OK');
  const expected = { Q1: { FES: 3, POA: 1, ROS: 1 }, Q2: { FES: 1, POA: 2 } };
  assert.deepEqual(r.matrix, expected);
  // The reported linearization is a valid topological order and folds to the same matrix.
  const pos = new Map(r.linearization.map((id, i) => [id, i]));
  for (const [u, outs] of r.graph.adj) for (const v of outs) assert.ok(pos.get(u) < pos.get(v));
  assert.deepEqual(foldOrder(r.linearization.map((id) => r.graph.byId.get(id)), r.effective), expected);
});

test('single-device history is LINEARIZABLE_MODEL', () => {
  const r = mergeHistories(
    [{ name: 'a', text: hist('A', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 }) }],
    CONFIG,
  );
  assert.equal(r.verdict, 'LINEARIZABLE_MODEL');
  assert.deepEqual(r.matrix, { Q1: { FES: 2 } });
});

test('concurrent writes to one cell with different tiers conflict', () => {
  const r = mergeHistories(
    [
      { name: 'a', text: hist('A', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 1 }) },
      { name: 'b', text: hist('B', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 3 }) },
    ],
    CONFIG,
  );
  assert.equal(r.verdict, 'CONFLICT');
  assert.equal(r.reason, 'WRITE_CONFLICT');
});

test('concurrent writes to one cell with equal tiers merge cleanly', () => {
  const r = mergeHistories(
    [
      { name: 'a', text: hist('A', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 }) },
      { name: 'b', text: hist('B', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 }) },
    ],
    CONFIG,
  );
  assert.equal(r.verdict, 'CONCURRENT_OK');
  assert.deepEqual(r.matrix, { Q1: { FES: 2 } });
});

test('acceptance 2: causal cycle returns a minimal cycle', () => {
  const r = mergeHistories([ex('cycle/devA.jsonl'), ex('cycle/devB.jsonl')], config);
  assert.equal(r.verdict, 'CONFLICT');
  assert.equal(r.reason, 'CAUSAL_CYCLE');
  assert.equal(r.cycle.length, 4);
  // every consecutive pair (and last->first) is a real happens-before edge
  for (let i = 0; i < r.cycle.length; i++) {
    const u = r.cycle[i];
    const v = r.cycle[(i + 1) % r.cycle.length];
    assert.ok(r.graph.adj.get(u).has(v), `missing edge ${u} -> ${v}`);
  }
  // minimal: no 2- or 3-cycles exist in this graph
  for (const [u, outs] of r.graph.adj) for (const v of outs) assert.ok(!r.graph.adj.get(v).has(u));
});

test('acceptance 3: PENDING when the cycle-detection budget is exhausted, no conflict judged', () => {
  const ops = Array.from({ length: 200 }, (_, i) => ({
    op: 'set_count',
    plot: 'Q1',
    species: 'FES',
    tier: 1,
  }));
  const r = mergeHistories([{ name: 'a', text: hist('A', ...ops) }], CONFIG, { budget: 10 });
  assert.equal(r.verdict, 'PENDING');
  assert.equal(r.reason, 'BUDGET_EXHAUSTED');
  assert.equal(r.conflicts, undefined);
  assert.equal(r.cycle, undefined);
});

test('morph_species propagates globally to unsynced facts on all devices', () => {
  const r = mergeHistories(
    [
      { name: 'a', text: hist('A', { op: 'morph_species', from: 'FES', to: 'FES2' }) },
      { name: 'b', text: hist('B', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 }) },
    ],
    CONFIG,
  );
  assert.equal(r.verdict, 'CONCURRENT_OK');
  assert.deepEqual(r.matrix, { Q1: { FES2: 2 } });
});

test('morph_species must not rewrite facts already committed by a sync', () => {
  const r = mergeHistories(
    [
      {
        name: 'a',
        text: hist(
          'A',
          { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 },
          { op: 'sync', session: 's1' },
          { op: 'morph_species', from: 'FES', to: 'FES2' },
        ),
      },
      {
        name: 'b',
        text: hist('B', { op: 'sync', session: 's1' }, { op: 'set_count', plot: 'Q1', species: 'POA', tier: 1 }),
      },
    ],
    CONFIG,
  );
  assert.equal(r.verdict, 'CONCURRENT_OK');
  assert.deepEqual(r.matrix, { Q1: { FES: 2, POA: 1 } });
});

test('morph merging two recorded populations violates total-count conservation', () => {
  const r = mergeHistories(
    [
      {
        name: 'a',
        text: hist(
          'A',
          { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 },
          { op: 'morph_species', from: 'FES', to: 'POA' },
        ),
      },
      { name: 'b', text: hist('B', { op: 'set_count', plot: 'Q1', species: 'POA', tier: 2 }) },
    ],
    CONFIG,
  );
  assert.equal(r.verdict, 'CONFLICT');
  assert.equal(r.reason, 'CONSERVATION_VIOLATION');
});

test('move_plot relocates records and respects capacity of the target plot', () => {
  const ok = mergeHistories(
    [
      {
        name: 'a',
        text: hist(
          'A',
          { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 },
          { op: 'move_plot', from: 'Q1', to: 'Q2' },
        ),
      },
    ],
    CONFIG,
  );
  assert.equal(ok.verdict, 'LINEARIZABLE_MODEL');
  assert.deepEqual(ok.matrix, { Q2: { FES: 2 } });

  const overflow = mergeHistories(
    [
      {
        name: 'a',
        text: hist(
          'A',
          { op: 'set_count', plot: 'Q1', species: 'FES', tier: 3 },
          { op: 'set_count', plot: 'Q1', species: 'POA', tier: 3 },
          { op: 'move_plot', from: 'Q1', to: 'Q2' },
        ),
      },
    ],
    CONFIG,
  );
  assert.equal(overflow.verdict, 'CONFLICT');
  assert.equal(overflow.reason, 'CAPACITY_EXCEEDED');
});

test('undo_op retracts an unsynced op', () => {
  const r = mergeHistories(
    [
      {
        name: 'a',
        text: hist(
          'A',
          { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 },
          { op: 'undo_op', target: 'A#1' },
        ),
      },
    ],
    CONFIG,
  );
  assert.equal(r.verdict, 'LINEARIZABLE_MODEL');
  assert.deepEqual(r.matrix, {});
});

test('undo_op of a synced op is INVALID_HISTORY', () => {
  assert.throws(
    () =>
      mergeHistories(
        [
          {
            name: 'a',
            text: hist(
              'A',
              { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 },
              { op: 'sync', session: 's1' },
              { op: 'undo_op', target: 'A#1' },
            ),
          },
          { name: 'b', text: hist('B', { op: 'sync', session: 's1' }, { op: 'set_count', plot: 'Q2', species: 'FES', tier: 1 }) },
        ],
        CONFIG,
      ),
    InvalidHistory,
  );
});

test('undo_op across devices is INVALID_HISTORY', () => {
  assert.throws(
    () =>
      mergeHistories(
        [
          { name: 'a', text: hist('A', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 2 }) },
          { name: 'b', text: hist('B', { op: 'undo_op', target: 'A#1' }) },
        ],
        CONFIG,
      ),
    InvalidHistory,
  );
});
