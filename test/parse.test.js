import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistory, InvalidHistory } from '../src/index.js';
import { CONFIG, hist } from './helpers.js';

test('parses a valid history', () => {
  const h = parseHistory(hist('A', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 1 }), { config: CONFIG });
  assert.equal(h.device, 'A');
  assert.equal(h.ops.length, 1);
  assert.equal(h.ops[0].id, 'A#1');
});

test('rejects invalid JSON lines', () => {
  assert.throws(() => parseHistory('{"op":"set_count"\nnot-json', {}), InvalidHistory);
});

test('rejects unknown op types', () => {
  assert.throws(() => parseHistory(hist('A', { op: 'nuke' }), {}), InvalidHistory);
});

test('rejects non-monotonic per-device time', () => {
  const text = [
    JSON.stringify({ op: 'set_count', device: 'A', time: 5, plot: 'Q1', species: 'FES', tier: 1 }),
    JSON.stringify({ op: 'set_count', device: 'A', time: 5, plot: 'Q1', species: 'FES', tier: 2 }),
  ].join('\n');
  assert.throws(() => parseHistory(text, {}), InvalidHistory);
});

test('rejects mixed devices in one file', () => {
  const text = [
    JSON.stringify({ op: 'sync', device: 'A', time: 1, session: 's' }),
    JSON.stringify({ op: 'sync', device: 'B', time: 2, session: 's' }),
  ].join('\n');
  assert.throws(() => parseHistory(text, {}), InvalidHistory);
});

test('rejects duplicate op ids', () => {
  const text = [
    JSON.stringify({ op: 'sync', device: 'A', time: 1, session: 's', id: 'x' }),
    JSON.stringify({ op: 'sync', device: 'A', time: 2, session: 't', id: 'x' }),
  ].join('\n');
  assert.throws(() => parseHistory(text, {}), InvalidHistory);
});

test('rejects unknown species / plots / tiers against config', () => {
  assert.throws(
    () => parseHistory(hist('A', { op: 'set_count', plot: 'Q1', species: 'NOPE', tier: 1 }), { config: CONFIG }),
    InvalidHistory,
  );
  assert.throws(
    () => parseHistory(hist('A', { op: 'set_count', plot: 'Q9', species: 'FES', tier: 1 }), { config: CONFIG }),
    InvalidHistory,
  );
  assert.throws(
    () => parseHistory(hist('A', { op: 'set_count', plot: 'Q1', species: 'FES', tier: 9 }), { config: CONFIG }),
    InvalidHistory,
  );
});

test('rejects morphologically incompatible set_count', () => {
  assert.throws(
    () => parseHistory(hist('A', { op: 'set_count', plot: 'Q2', species: 'ROS', tier: 1 }), { config: CONFIG }),
    InvalidHistory,
  );
});

test('rejects dangling sync sessions at graph build', async () => {
  const { mergeHistories } = await import('../src/index.js');
  assert.throws(
    () => mergeHistories([{ name: 'a', text: hist('A', { op: 'sync', session: 'solo' }) }], CONFIG),
    InvalidHistory,
  );
});
