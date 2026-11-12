import test from 'node:test';
import { associateHeaders } from '../index.js';
import { expectAssociationError, makeCell, makeGrid } from './helpers.js';

test('explicit headers: multi-step dependency cycle fails with reproducible path', () => {
  const leaf = makeCell('leaf', 'header', 'Leaf');
  const headerC = makeCell('hc', 'header', 'C', { headers: ['ha'] });
  const headerB = makeCell('hb', 'header', 'B', { headers: ['hc'] });
  const headerA = makeCell('ha', 'header', 'A', { headers: ['hb'] });
  const data = makeCell('d', 'data', 'v', { headers: ['ha'] });

  const grid = makeGrid({
    cells: [leaf, headerA, headerB, headerC, data],
    layout: [['leaf', 'ha', 'hb', 'hc', 'd']],
  });

  expectAssociationError(
    () => associateHeaders(grid),
    'CYCLIC_HEADER_DEPENDENCY',
    ['d', 'ha', 'hb', 'hc', 'ha'],
  );
});

test('explicit headers: self cycle fails and deterministically repeats across runs', () => {
  const self = makeCell('s', 'header', 'Self', { headers: ['s'] });
  const data = makeCell('d', 'data', 'v', { headers: ['s'] });
  const grid = makeGrid({ cells: [self, data], layout: [['s', 'd']] });

  const run = (): void =>
    expectAssociationError(
      () => associateHeaders(grid),
      'CYCLIC_HEADER_DEPENDENCY',
      ['d', 's', 's'],
    );

  run();
  run();
});

test('explicit headers: cycle reached through a diamond reports full trail', () => {
  // shared -> back forms the cycle; the join is reached via two parents.
  const back = makeCell('back', 'header', 'Back', { headers: ['shared'] });
  const shared = makeCell('shared', 'header', 'Shared', { headers: ['back'] });
  const parentOne = makeCell('p1', 'header', 'P1', { headers: ['shared'] });
  const parentTwo = makeCell('p2', 'header', 'P2', { headers: ['shared'] });
  const data = makeCell('d', 'data', 'v', { headers: ['p1', 'p2'] });

  const grid = makeGrid({
    cells: [back, shared, parentOne, parentTwo, data],
    layout: [['back', 'shared', 'p1', 'p2', 'd']],
  });

  expectAssociationError(
    () => associateHeaders(grid),
    'CYCLIC_HEADER_DEPENDENCY',
    ['d', 'p1', 'shared', 'back', 'shared'],
  );
});
