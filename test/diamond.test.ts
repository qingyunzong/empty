import test from 'node:test';
import assert from 'node:assert/strict';
import { associateHeaders } from '../index.js';
import { expectAssociationError, makeCell, makeGrid, snapshot } from './helpers.js';

test('explicit headers: diamond dependency expands to ordered, first-reach leaves', () => {
  // Leaf headers have no further dependencies; internal headers point at them.
  const leafA = makeCell('la', 'header', 'Leaf A');
  const leafB = makeCell('lb', 'header', 'Leaf B');
  const midLeft = makeCell('ml', 'header', 'Mid Left', { headers: ['la', 'lb'] });
  const midRight = makeCell('mr', 'header', 'Mid Right', { headers: ['lb'] });
  const rootHeader = makeCell('rh', 'header', 'Root', {
    headers: ['ml', 'mr'],
  });
  const data = makeCell('d1', 'data', 'value', { headers: ['rh'] });

  const grid = makeGrid({
    cells: [rootHeader, midLeft, midRight, leafA, leafB, data],
    layout: [['rh', 'ml', 'mr', 'la', 'lb', 'd1']],
  });

  // rh -> ml -> la, lb ; then rh -> mr -> lb (lb already reached, skipped).
  assert.deepEqual(snapshot(associateHeaders(grid)), [
    { dataId: 'd1', text: 'value', headerPath: ['la', 'lb'] },
  ]);
});

test('explicit headers: authored order and first reach beat reference count', () => {
  const leafA = makeCell('a', 'header', 'A');
  const leafB = makeCell('b', 'header', 'B');
  const leafC = makeCell('c', 'header', 'C');
  // b is referenced twice (by x and directly), but must stay second.
  const middle = makeCell('x', 'header', 'X', { headers: ['b', 'c'] });
  const data = makeCell('d', 'data', 'v', {
    headers: ['a', 'x', 'b'],
  });

  const grid = makeGrid({
    cells: [leafA, leafB, leafC, middle, data],
    layout: [['a', 'b', 'c', 'x', 'd']],
  });

  assert.deepEqual(snapshot(associateHeaders(grid)), [
    { dataId: 'd', text: 'v', headerPath: ['a', 'b', 'c'] },
  ]);
});

test('explicit headers: missing referenced id fails the whole table with a path', () => {
  const data = makeCell('d', 'data', 'v', { headers: ['ghost'] });
  const grid = makeGrid({ cells: [data], layout: [['d']] });

  expectAssociationError(
    () => associateHeaders(grid),
    'MISSING_HEADER_ID',
    ['d', 'ghost'],
  );
});

test('explicit headers: referencing a data cell fails with a path', () => {
  const otherData = makeCell('target', 'data', 'target-text');
  const data = makeCell('d', 'data', 'v', { headers: ['target'] });
  const grid = makeGrid({
    cells: [otherData, data],
    layout: [['target', 'd']],
  });

  expectAssociationError(
    () => associateHeaders(grid),
    'HEADER_REFERS_TO_DATA',
    ['d', 'target'],
  );
});
