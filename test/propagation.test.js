'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { iso } = require('./helpers');

function build({ lots, edges, tests }) {
  const engine = new Engine({ lots, edges, tests });
  assert.deepEqual(engine.errors, []);
  engine.computeAll();
  engine.issueCertificates();
  return engine;
}

test('split: one failing raw material contaminates multiple downstream batches', () => {
  const engine = build({
    lots: [
      { id: 'RM', type: 'raw_material', production_start: iso(0), production_end: iso(1) },
      { id: 'B1', type: 'intermediate', production_start: iso(2), production_end: iso(3) },
      { id: 'B2', type: 'intermediate', production_start: iso(2), production_end: iso(3) },
    ],
    edges: [
      { from: 'RM', to: 'B1' },
      { from: 'RM', to: 'B2' },
    ],
    tests: [{ id: 'T1', lot: 'RM', result: 'fail' }],
  });
  assert.equal(engine.state.get('B1').status, 'FAIL');
  assert.equal(engine.state.get('B2').status, 'FAIL');
});

test('merge: several raw materials flow into one finished good', () => {
  const engine = build({
    lots: [
      { id: 'R1', type: 'raw_material', production_start: iso(0), production_end: iso(1) },
      { id: 'R2', type: 'raw_material', production_start: iso(0), production_end: iso(1) },
      { id: 'FG', type: 'finished_good', production_start: iso(2), production_end: iso(3) },
    ],
    edges: [
      { from: 'R1', to: 'FG' },
      { from: 'R2', to: 'FG' },
    ],
    tests: [
      { id: 'T1', lot: 'R1', result: 'pass' },
      { id: 'T2', lot: 'R2', result: 'fail' },
    ],
  });
  assert.equal(engine.state.get('FG').status, 'FAIL');
  assert.deepEqual(engine.state.get('FG').contaminatedBy, ['T2']);
});

test('failure propagates only when edge validity covers the production window', () => {
  const lots = [
    { id: 'RM', type: 'raw_material', production_start: iso(0), production_end: iso(1) },
    { id: 'FG', type: 'finished_good', production_start: iso(10), production_end: iso(20) },
  ];
  const tests = [{ id: 'T1', lot: 'RM', result: 'fail' }];
  const covering = build({ lots, edges: [{ from: 'RM', to: 'FG', valid_from: iso(5), valid_to: iso(25) }], tests });
  assert.equal(covering.state.get('FG').status, 'FAIL');
  const partial = build({ lots, edges: [{ from: 'RM', to: 'FG', valid_from: iso(15), valid_to: iso(25) }], tests });
  assert.equal(partial.state.get('FG').status, 'UNKNOWN');
  const disjoint = build({ lots, edges: [{ from: 'RM', to: 'FG', valid_from: iso(30), valid_to: iso(40) }], tests });
  assert.equal(disjoint.state.get('FG').status, 'UNKNOWN');
});

test('UNKNOWN means missing evidence and is never FAIL', () => {
  const engine = build({
    lots: [
      { id: 'RM', type: 'raw_material' },
      { id: 'FG', type: 'finished_good' },
    ],
    edges: [{ from: 'RM', to: 'FG' }],
    tests: [],
  });
  assert.equal(engine.state.get('RM').status, 'UNKNOWN');
  assert.equal(engine.state.get('FG').status, 'UNKNOWN');
  assert.notEqual(engine.state.get('FG').status, 'FAIL');
});

test('PASS propagates structurally when every input passes', () => {
  const engine = build({
    lots: [
      { id: 'R1', type: 'raw_material' },
      { id: 'R2', type: 'raw_material' },
      { id: 'FG', type: 'finished_good' },
    ],
    edges: [
      { from: 'R1', to: 'FG' },
      { from: 'R2', to: 'FG' },
    ],
    tests: [
      { id: 'T1', lot: 'R1', result: 'pass' },
      { id: 'T2', lot: 'R2', result: 'pass' },
    ],
  });
  assert.equal(engine.state.get('FG').status, 'PASS');
});

test('one UNKNOWN input keeps the finished good UNKNOWN', () => {
  const engine = build({
    lots: [
      { id: 'R1', type: 'raw_material' },
      { id: 'R2', type: 'raw_material' },
      { id: 'FG', type: 'finished_good' },
    ],
    edges: [
      { from: 'R1', to: 'FG' },
      { from: 'R2', to: 'FG' },
    ],
    tests: [{ id: 'T1', lot: 'R1', result: 'pass' }],
  });
  assert.equal(engine.state.get('FG').status, 'UNKNOWN');
});
