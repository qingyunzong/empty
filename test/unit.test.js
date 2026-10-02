'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../lib/engine');
const { validate } = require('../lib/validate');
const { main } = require('../cli');

const W = (d) => ({ start: `2026-01-0${d}T00:00:00Z`, end: `2026-01-0${d}T08:00:00Z` });

function engineOf(input) {
  const { errors, lots, edges, tests } = validate(input);
  assert.deepEqual(errors, []);
  const engine = new Engine({ lots, edges, tests });
  engine.computeInitial();
  return engine;
}

test('UNKNOWN means missing evidence and is never reported as FAIL', () => {
  const engine = engineOf({
    lots: [
      { id: 'R', window: W(1) },
      { id: 'P', window: W(2) },
    ],
    edges: [{ id: 'E1', from: 'R', to: 'P' }],
    tests: [],
    corrections: [],
  });
  assert.equal(engine.statusOf('P'), 'UNKNOWN');
  assert.notEqual(engine.statusOf('P'), 'FAIL');
});

test('merge and split: one raw feeds many, many raws feed one product', () => {
  const engine = engineOf({
    lots: [
      { id: 'R1', window: W(1) },
      { id: 'R2', window: W(1) },
      { id: 'M', window: W(2) },
      { id: 'P1', window: W(3) },
      { id: 'P2', window: W(3) },
    ],
    edges: [
      { id: 'E1', from: 'R1', to: 'M' },
      { id: 'E2', from: 'R2', to: 'M' },
      { id: 'E3', from: 'M', to: 'P1' },
      { id: 'E4', from: 'M', to: 'P2' },
    ],
    tests: [
      { id: 'T1', lot: 'R1', result: 'pass' },
      { id: 'T2', lot: 'R2', result: 'fail' },
      { id: 'T3', lot: 'M', result: 'pass' },
    ],
    corrections: [],
  });
  assert.equal(engine.statusOf('M'), 'FAIL');
  assert.equal(engine.statusOf('P1'), 'FAIL');
  assert.equal(engine.statusOf('P2'), 'FAIL');
});

test('failure does not propagate when edge valid-time does not cover the production window', () => {
  const engine = engineOf({
    lots: [
      { id: 'R', window: W(1) },
      { id: 'P', window: W(5) },
    ],
    edges: [
      { id: 'E1', from: 'R', to: 'P', valid_from: '2026-01-01T00:00:00Z', valid_to: '2026-01-02T00:00:00Z' },
    ],
    tests: [
      { id: 'T1', lot: 'R', result: 'fail' },
      { id: 'T2', lot: 'P', result: 'pass' },
    ],
    corrections: [],
  });
  assert.equal(engine.statusOf('R'), 'FAIL');
  assert.equal(engine.statusOf('P'), 'PASS');
});

test('validation: edge referencing a nonexistent lot is an error', () => {
  const { errors } = validate({
    lots: [{ id: 'A', window: W(1) }],
    edges: [{ id: 'E1', from: 'A', to: 'GHOST' }],
    tests: [],
    corrections: [],
  });
  assert.ok(errors.some((e) => e.code === 'UNKNOWN_LOT'));
});

test('validation: correction targeting a nonexistent test or edge is an error', () => {
  const { errors } = validate({
    lots: [{ id: 'A', window: W(1) }],
    edges: [],
    tests: [],
    corrections: [
      { type: 'revoke_test', test_id: 'NOPE' },
      { type: 'update_edge', edge_id: 'ALSO_NOPE', valid_to: '2026-01-01T00:00:00Z' },
    ],
  });
  assert.ok(errors.some((e) => e.code === 'UNKNOWN_TEST'));
  assert.ok(errors.some((e) => e.code === 'UNKNOWN_EDGE'));
});

test('CLI happy path: writes trace.json and certificates.jsonl, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ok-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(inDir);
  fs.writeFileSync(
    path.join(inDir, 'lots.json'),
    JSON.stringify([
      { id: 'R', window: W(1) },
      { id: 'P', window: W(2) },
    ])
  );
  fs.writeFileSync(path.join(inDir, 'edges.jsonl'), '{"id":"E1","from":"R","to":"P"}\n');
  fs.writeFileSync(
    path.join(inDir, 'tests.jsonl'),
    '{"id":"T1","lot":"R","result":"fail"}\n{"id":"T2","lot":"P","result":"pass"}\n'
  );
  fs.writeFileSync(path.join(inDir, 'corrections.jsonl'), '{"type":"revoke_test","test_id":"T1"}\n');

  assert.equal(main(['trace', '--in', inDir, '--out', outDir]), 0);

  const trace = JSON.parse(fs.readFileSync(path.join(outDir, 'trace.json'), 'utf8'));
  assert.deepEqual(trace.products.map((p) => p.lot), ['P']);
  // T1 revoked -> R has no evidence (UNKNOWN), which propagates to P.
  assert.equal(trace.products[0].status, 'UNKNOWN');
  const certs = fs
    .readFileSync(path.join(outDir, 'certificates.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(certs.length, 2);
  assert.equal(certs[0].revoked, true);
  assert.equal(certs[0].superseded_by, certs[1].hash);
  assert.equal(certs[1].revoked, false);
  assert.equal(trace.products[0].certificate_hash, certs[1].hash);
});
