'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateShipment } = require('../lib/core');

const baseShipment = {
  shipment_id: 'sh1',
  batch_id: 'b1',
  sensor_id: 's1',
  in_ts: 0,
  out_ts: 1000,
  min_c: 2,
  max_c: 8,
  max_gap_s: 300,
};

function reading(ts, temp_c) {
  return { sensor_id: 's1', ts, temp_c };
}

test('gap of exactly max_gap is compliant', () => {
  const readings = [reading(0, 5), reading(300, 5), reading(600, 5), reading(900, 5)];
  const result = evaluateShipment(baseShipment, readings, []);
  assert.equal(result.unknown_seconds, 0);
  assert.equal(result.excursion_seconds, 0);
  assert.equal(result.verdict, 'COMPLIANT');
});

test('gap of max_gap + 1 second is UNKNOWN', () => {
  const readings = [reading(0, 5), reading(301, 5), reading(602, 5), reading(903, 5)];
  const result = evaluateShipment(baseShipment, readings, []);
  assert.ok(result.unknown_seconds > 0);
  assert.equal(result.verdict, 'UNKNOWN');
});

test('UNKNOWN gap never counts as excursion even with out-of-range temp', () => {
  const readings = [reading(0, 20), reading(301, 5), reading(601, 5), reading(900, 5)];
  const result = evaluateShipment(baseShipment, readings, []);
  assert.equal(result.excursion_seconds, 0);
  assert.equal(result.unknown_seconds, 301);
  assert.equal(result.verdict, 'UNKNOWN');
});

test('in-range excursion seconds accumulate within max_gap', () => {
  const readings = [reading(0, 20), reading(100, 5), reading(400, 5), reading(700, 5), reading(950, 5)];
  const result = evaluateShipment(baseShipment, readings, []);
  assert.equal(result.excursion_seconds, 100);
  assert.equal(result.verdict, 'EXCURSION');
});

test('empty window is UNKNOWN, never non-compliant', () => {
  const result = evaluateShipment(baseShipment, [], []);
  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(result.unknown_seconds, 1000);
});
