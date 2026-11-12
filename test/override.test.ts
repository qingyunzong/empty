import test from 'node:test';
import assert from 'node:assert/strict';
import { associateHeaders } from '../index.js';
import type { Cell } from '../index.js';
import { makeCell, makeGrid, snapshot } from './helpers.js';

test('non-empty explicit headers override geometric auto-association', () => {
  const rowHeader = makeCell('rh', 'header', 'Row', { scope: 'row' });
  const colHeader = makeCell('ch', 'header', 'Col', { scope: 'col' });
  const farHeader = makeCell('far', 'header', 'Far Header');
  const explicitLeaf = makeCell('leaf', 'header', 'Explicit Leaf');
  const explicitMid = makeCell('mid', 'header', 'Explicit Mid', {
    headers: ['leaf'],
  });
  const automatic = makeCell('auto', 'data', 'auto-value');
  const explicit = makeCell('manual', 'data', 'manual-value', {
    headers: ['mid'],
  });

  const grid = makeGrid({
    cells: [
      rowHeader,
      colHeader,
      farHeader,
      explicitLeaf,
      explicitMid,
      automatic,
      explicit,
    ],
    layout: [
      ['far', 'ch', 'leaf', 'mid'],
      ['rh', 'auto', 'manual', 'manual'],
    ],
  });

  assert.deepEqual(snapshot(associateHeaders(grid)), [
    // auto has empty headers -> geometric association only.
    { dataId: 'auto', text: 'auto-value', headerPath: ['rh', 'ch'] },
    // manual has explicit headers -> only the explicit leaf, ignoring geometry.
    { dataId: 'manual', text: 'manual-value', headerPath: ['leaf'] },
  ]);
});

test('empty headers array means implicit association, not an empty path', () => {
  const rowHeader = makeCell('rh', 'header', 'Row', { scope: 'row' });
  const colHeader = makeCell('ch', 'header', 'Col', { scope: 'col' });
  const data = makeCell('d', 'data', 'v', { headers: [] });

  const grid = makeGrid({
    cells: [rowHeader, colHeader, data],
    layout: [
      ['ch', 'ch'],
      ['rh', 'd'],
    ],
  });

  assert.deepEqual(snapshot(associateHeaders(grid)), [
    { dataId: 'd', text: 'v', headerPath: ['rh', 'ch'] },
  ]);
});

test('input grid and cells are never mutated', () => {
  const rowHeader = makeCell('rh', 'header', 'Row', { scope: 'row' });
  const colHeader = makeCell('ch', 'header', 'Col', { scope: 'col' });
  const data = makeCell('d', 'data', 'keep-me');
  const grid = makeGrid({
    cells: [rowHeader, colHeader, data],
    layout: [
      ['ch', 'ch'],
      ['rh', 'd'],
    ],
  });

  const frozenGrid = grid.map((row) =>
    Object.freeze([...row]),
  ) as Cell[][];
  for (const cell of [rowHeader, colHeader, data]) {
    Object.freeze(cell.headers);
    Object.freeze(cell);
  }

  const results = associateHeaders(frozenGrid);
  assert.equal(results[0]!.text, 'keep-me');
  assert.deepEqual(data.headers, []);
  assert.equal(grid[1]![1], data);
});

test('results are ordered by data cell top-left regardless of grid traversal', () => {
  const colHeader = makeCell('ch', 'header', 'Metric', { scope: 'col' });
  const dFirst = makeCell('d-first', 'data', 'first');
  const dSecond = makeCell('d-second', 'data', 'second');

  const grid = makeGrid({
    cells: [colHeader, dFirst, dSecond],
    layout: [
      ['ch', 'ch'],
      ['d-first', 'd-second'],
    ],
  });

  assert.deepEqual(
    associateHeaders(grid).map((result) => result.dataId),
    ['d-first', 'd-second'],
  );
});
