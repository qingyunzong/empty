'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pointInPolygon } = require('../src/polygon');

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

test('strictly inside point is inside', () => {
  assert.equal(pointInPolygon(5, 5, SQUARE), true);
});

test('strictly outside point is outside', () => {
  assert.equal(pointInPolygon(15, 5, SQUARE), false);
  assert.equal(pointInPolygon(-1, 5, SQUARE), false);
});

test('point on edge counts as inside', () => {
  assert.equal(pointInPolygon(10, 5, SQUARE), true);
  assert.equal(pointInPolygon(0, 5, SQUARE), true);
  assert.equal(pointInPolygon(5, 0, SQUARE), true);
  assert.equal(pointInPolygon(5, 10, SQUARE), true);
});

test('point on vertex counts as inside', () => {
  assert.equal(pointInPolygon(0, 0, SQUARE), true);
  assert.equal(pointInPolygon(10, 10, SQUARE), true);
});

test('even-odd rule: center of self-intersecting bowtie is outside', () => {
  const bowtie = [
    [0, 0],
    [10, 10],
    [10, 0],
    [0, 10],
  ];
  assert.equal(pointInPolygon(5, 2, bowtie), false);
  assert.equal(pointInPolygon(8, 5, bowtie), true);
  assert.equal(pointInPolygon(5, 5, bowtie), true);
});

test('concave polygon follows even-odd rule', () => {
  const concave = [
    [0, 0],
    [10, 0],
    [10, 10],
    [5, 5],
    [0, 10],
  ];
  assert.equal(pointInPolygon(5, 8, concave), false);
  assert.equal(pointInPolygon(2, 2, concave), true);
});
