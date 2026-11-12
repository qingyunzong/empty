import test from 'node:test';
import assert from 'node:assert/strict';
import { associateHeaders } from '../index.js';
import { makeCell, makeGrid, snapshot } from './helpers.js';

test('implicit: row headers (left, overlapping rows) then col headers (above, overlapping columns)', () => {
  // Layout (4 rows x 4 cols). Repeated ids are the same spanning object.
  // r0: [rh1(span r0-r1), chA, chA, chB]
  // r1: [rh1,            d11, d11, d12]
  // r2: [rh2,            d21, d22, d22]
  // r3: [rh3(span c0-c1),d21? no -> d31 in c2..] kept simple below
  const rh1 = makeCell('rh1', 'header', 'Region A', { scope: 'row' });
  const rh2 = makeCell('rh2', 'header', 'Region B', { scope: 'row' });
  const rh3 = makeCell('rh3', 'header', 'Region C', { scope: 'row' });
  const chA = makeCell('chA', 'header', 'Q1+Q2', { scope: 'col' });
  const chB = makeCell('chB', 'header', 'Q3', { scope: 'col' });

  const d11 = makeCell('d11', 'data', '11');
  const d12 = makeCell('d12', 'data', '12');
  const d21 = makeCell('d21', 'data', '21');
  const d22 = makeCell('d22', 'data', '22');
  const d31 = makeCell('d31', 'data', '31');

  const grid = makeGrid({
    cells: [rh1, rh2, rh3, chA, chB, d11, d12, d21, d22, d31],
    layout: [
      ['rh1', 'chA', 'chA', 'chB'],
      ['rh1', 'd11', 'd11', 'd12'],
      ['rh2', 'd21', 'd22', 'd22'],
      ['rh3', 'rh3', 'd31', 'd31'],
    ],
  });

  assert.deepEqual(snapshot(associateHeaders(grid)), [
    // d11 spans r1 c1-c2: row header rh1 overlaps row1 and is left;
    // col headers chA (overlaps c1-c2) and chB (c3) -> only chA overlaps.
    { dataId: 'd11', text: '11', headerPath: ['rh1', 'chA'] },
    // d12 at r1 c3: chB overlaps column 3 and is above.
    { dataId: 'd12', text: '12', headerPath: ['rh1', 'chB'] },
    { dataId: 'd21', text: '21', headerPath: ['rh2', 'chA'] },
    // d22 spans r2 c2-c3: overlaps both chA (c2) and chB (c3).
    { dataId: 'd22', text: '22', headerPath: ['rh2', 'chA', 'chB'] },
    // d31 spans r3 c2-c3; rh3 spans c0-c1 and is fully left.
    { dataId: 'd31', text: '31', headerPath: ['rh3', 'chA', 'chB'] },
  ]);
});

test('implicit: data spanning multiple rows collects every overlapping left row header', () => {
  const rhTop = makeCell('rt', 'header', 'Top', { scope: 'row' });
  const rhBottom = makeCell('rb', 'header', 'Bottom', { scope: 'row' });
  const colHeader = makeCell('ch', 'header', 'Metric', { scope: 'col' });
  const big = makeCell('big', 'data', 'merged');

  const grid = makeGrid({
    cells: [rhTop, rhBottom, colHeader, big],
    layout: [
      ['ch', 'ch'],
      ['rt', 'big'],
      ['rb', 'big'],
    ],
  });

  // big spans r1-r2 c1: both rt and rb overlap its rows and are left.
  assert.deepEqual(snapshot(associateHeaders(grid)), [
    { dataId: 'big', text: 'merged', headerPath: ['rt', 'rb', 'ch'] },
  ]);
});

test('implicit: scope-none header and non-overlapping headers are ignored', () => {
  const rowHeader = makeCell('rh', 'header', 'Row', { scope: 'row' });
  const neutral = makeCell('nh', 'header', 'Neutral', { scope: 'none' });
  const colHeader = makeCell('ch', 'header', 'Col', { scope: 'col' });
  const data = makeCell('d', 'data', 'x');

  const grid = makeGrid({
    cells: [rowHeader, neutral, colHeader, data],
    layout: [
      ['nh', 'ch'],
      ['rh', 'd'],
    ],
  });

  // nh sits above rh (column 0), never overlaps d's column, and is scope none
  // anyway; only the row header rh and col header ch qualify.
  assert.deepEqual(snapshot(associateHeaders(grid)), [
    { dataId: 'd', text: 'x', headerPath: ['rh', 'ch'] },
  ]);
});
