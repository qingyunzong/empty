'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../lib/engine');
const { validate } = require('../lib/validate');
const { main } = require('../cli');
const { oracleStatuses, applyCorrectionsToData, randomCase } = require('./helpers');

function buildEngine(input) {
  const { errors, lots, edges, tests } = validate(input);
  assert.deepEqual(errors, []);
  return new Engine({ lots, edges, tests });
}

test('acceptance 1: incremental results match independent recursive full recompute on random DAGs (n<=10)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const n = 2 + (seed % 9); // 2..10 lots
    const input = randomCase(seed, n);
    const engine = buildEngine(input);
    engine.computeInitial();
    for (const c of input.corrections) engine.applyCorrection(c);

    // (a) Independent recursive oracle agrees on every lot status.
    const oracle = oracleStatuses(input);
    for (const [id, expected] of oracle) {
      assert.equal(engine.statusOf(id), expected, `seed=${seed} lot=${id}`);
    }

    // (b) Incremental engine agrees with a from-scratch full recompute
    // on corrected data, including certificate hashes.
    const corrected = applyCorrectionsToData(input);
    const fresh = buildEngine({ ...corrected, corrections: [] });
    fresh.computeInitial();
    assert.deepEqual(engine.products(), fresh.products(), `seed=${seed} products differ`);
  }
});

test('acceptance 2: revoking a failing test flips only downstream products FAIL -> PASS/UNKNOWN', () => {
  const input = {
    lots: [
      { id: 'R', window: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T08:00:00Z' } },
      { id: 'R2', window: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T08:00:00Z' } },
      { id: 'P', window: { start: '2026-01-02T00:00:00Z', end: '2026-01-02T08:00:00Z' } },
      { id: 'Q', window: { start: '2026-01-02T00:00:00Z', end: '2026-01-02T08:00:00Z' } },
    ],
    edges: [
      { id: 'E1', from: 'R', to: 'P', valid_from: '2026-01-01T00:00:00Z', valid_to: '2026-01-31T00:00:00Z' },
      { id: 'E2', from: 'R2', to: 'Q', valid_from: '2026-01-01T00:00:00Z', valid_to: '2026-01-31T00:00:00Z' },
    ],
    tests: [
      { id: 'T1', lot: 'R', result: 'fail' },
      { id: 'T2', lot: 'R2', result: 'pass' },
      { id: 'T3', lot: 'Q', result: 'pass' },
    ],
    corrections: [],
  };
  const engine = buildEngine(input);
  engine.computeInitial();
  assert.equal(engine.statusOf('P'), 'FAIL');
  assert.equal(engine.statusOf('Q'), 'PASS');
  const qHashBefore = engine.certificateHashOf('Q');
  const pHashBefore = engine.certificateHashOf('P');

  const { changed } = engine.applyCorrection({ type: 'revoke_test', test_id: 'T1' });

  // Only the downstream product P is affected; R has no remaining test
  // evidence so P degrades to UNKNOWN (missing evidence, never FAIL).
  assert.deepEqual(changed, ['P']);
  assert.equal(engine.statusOf('P'), 'UNKNOWN');
  assert.equal(engine.statusOf('Q'), 'PASS');
  assert.equal(engine.certificateHashOf('Q'), qHashBefore);
  assert.notEqual(engine.certificateHashOf('P'), pHashBefore);

  // Old certificate for P is revoked and points at the new one.
  const pCerts = engine.certLog.filter((c) => c.lot === 'P');
  assert.equal(pCerts.length, 2);
  assert.equal(pCerts[0].revoked, true);
  assert.equal(pCerts[0].superseded_by, pCerts[1].hash);
  assert.equal(pCerts[1].revoked, false);
  // Q was never re-issued.
  assert.equal(engine.certLog.filter((c) => c.lot === 'Q').length, 1);
});

test('acceptance 3: shortening edge valid-time breaks propagation, hash changes, old cert revoked', () => {
  const input = {
    lots: [
      { id: 'R', window: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T08:00:00Z' } },
      { id: 'P', window: { start: '2026-01-10T00:00:00Z', end: '2026-01-10T08:00:00Z' } },
    ],
    edges: [
      { id: 'E1', from: 'R', to: 'P', valid_from: '2026-01-01T00:00:00Z', valid_to: '2026-01-31T00:00:00Z' },
    ],
    tests: [{ id: 'T1', lot: 'R', result: 'fail' }],
    corrections: [],
  };
  const engine = buildEngine(input);
  engine.computeInitial();
  assert.equal(engine.statusOf('P'), 'FAIL');
  const hashBefore = engine.certificateHashOf('P');

  // valid_to now ends before P's production window: propagation broken.
  engine.applyCorrection({ type: 'update_edge', edge_id: 'E1', valid_to: '2026-01-05T00:00:00Z' });

  assert.equal(engine.statusOf('P'), 'UNKNOWN');
  const hashAfter = engine.certificateHashOf('P');
  assert.notEqual(hashAfter, hashBefore);
  const certs = engine.certLog.filter((c) => c.lot === 'P');
  assert.equal(certs.length, 2);
  assert.equal(certs[0].hash, hashBefore);
  assert.equal(certs[0].revoked, true);
  assert.equal(certs[0].superseded_by, hashAfter);
  assert.equal(certs[1].hash, hashAfter);
  assert.equal(certs[1].revoked, false);
});

test('acceptance 4: a cycle is rejected with exit=2 and no partial certificates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cycle-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(inDir);
  fs.writeFileSync(
    path.join(inDir, 'lots.json'),
    JSON.stringify([
      { id: 'A', window: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T08:00:00Z' } },
      { id: 'B', window: { start: '2026-01-02T00:00:00Z', end: '2026-01-02T08:00:00Z' } },
    ])
  );
  fs.writeFileSync(
    path.join(inDir, 'edges.jsonl'),
    '{"id":"E1","from":"A","to":"B"}\n{"id":"E2","from":"B","to":"A"}\n'
  );
  fs.writeFileSync(path.join(inDir, 'tests.jsonl'), '{"id":"T1","lot":"A","result":"pass"}\n');
  fs.writeFileSync(path.join(inDir, 'corrections.jsonl'), '');

  assert.equal(main(['trace', '--in', inDir, '--out', outDir]), 2);

  const errors = fs
    .readFileSync(path.join(outDir, 'errors.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(errors.some((e) => e.code === 'CYCLE'));

  // No partial output: neither trace.json nor certificates.jsonl may exist.
  assert.equal(fs.existsSync(path.join(outDir, 'trace.json')), false);
  assert.equal(fs.existsSync(path.join(outDir, 'certificates.jsonl')), false);
});
