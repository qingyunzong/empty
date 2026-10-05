import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistories } from '../src/merge.js';
import { InvalidHistory } from '../src/errors.js';
import { CONFIG, lines } from './helpers.js';

const bad = (name, inputs) =>
  test(`INVALID_HISTORY: ${name}`, () => {
    assert.throws(() => mergeHistories(CONFIG, inputs), InvalidHistory);
  });

bad('malformed JSON line', [{ name: 'A', text: '{"id":"a1", oops\n' }]);

bad('unknown op type', [
  { name: 'A', text: lines({ id: 'a1', device: 'A', ts: 1, op: 'teleport', plot: 'P1' }) },
]);

bad('non-monotonic per-device time', [
  {
    name: 'A',
    text: lines(
      { id: 'a1', device: 'A', ts: 5, op: 'set_count', plot: 'P1', species: 'S1', tier: 1 },
      { id: 'a2', device: 'A', ts: 5, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 }
    ),
  },
]);

bad('duplicate op id', [
  { name: 'A', text: lines({ id: 'x', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 1 }) },
  { name: 'B', text: lines({ id: 'x', device: 'B', ts: 1, op: 'set_count', plot: 'P2', species: 'S1', tier: 1 }) },
]);

bad('plot over capacity (area carrying limit)', [
  {
    name: 'A',
    text: lines(
      { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P2', species: 'S1', tier: 5 },
      { id: 'a2', device: 'A', ts: 2, op: 'set_count', plot: 'P2', species: 'S2', tier: 2 } // 5+2 > area 6
    ),
  },
]);

bad('tier out of finite domain', [
  { name: 'A', text: lines({ id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 6 }) },
]);

bad('morph-incompatible species rename', [
  { name: 'A', text: lines({ id: 'a1', device: 'A', ts: 1, op: 'morph_species', from: 'S1', to: 'G1' }) },
]);

bad('move_plot violates total conservation (insufficient source)', [
  { name: 'A', text: lines({ id: 'a1', device: 'A', ts: 1, op: 'move_plot', plot: 'P1', from: 'S1', to: 'S2', count: 1 }) },
]);

bad('unpaired sync rendezvous', [
  { name: 'A', text: lines({ id: 'a1', device: 'A', ts: 1, op: 'sync', with: 'B', mark: 'm1' }) },
]);

bad('undo_op of an already-synced op', [
  {
    name: 'A',
    text: lines(
      { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 1 },
      { id: 'a2', device: 'A', ts: 2, op: 'sync', with: 'B', mark: 'm1' },
      { id: 'a3', device: 'A', ts: 3, op: 'undo_op', target: 'a1' }
    ),
  },
  { name: 'B', text: lines({ id: 'b1', device: 'B', ts: 1, op: 'sync', with: 'A', mark: 'm1' }) },
]);

bad('undo_op must retract the latest unsynced op (stack discipline)', [
  {
    name: 'A',
    text: lines(
      { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 1 },
      { id: 'a2', device: 'A', ts: 2, op: 'set_count', plot: 'P1', species: 'S2', tier: 1 },
      { id: 'a3', device: 'A', ts: 3, op: 'undo_op', target: 'a1' }
    ),
  },
]);

bad('unknown species', [
  { name: 'A', text: lines({ id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'XX', tier: 1 }) },
]);
