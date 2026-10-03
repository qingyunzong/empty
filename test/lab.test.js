import test from 'node:test';
import assert from 'node:assert/strict';
import { Lab, replay } from '../src/lab.js';
import { referenceEvaluate } from '../src/reference.js';

function baseLab() {
  const lab = new Lab();
  lab.apply({ op: 'setNow', now: '2026-01-01' });
  lab.apply({ op: 'addBatch', id: 'B1', expiresAt: '2027-01-01', concentration: 1.0 });
  lab.apply({ op: 'addBatch', id: 'B2', expiresAt: '2027-01-01', concentration: 2.0 });
  lab.apply({ op: 'addBatch', id: 'B3', expiresAt: '2027-01-01', concentration: 3.0 });
  return lab;
}

test('valid result chooses declared batch when valid', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
  const out = lab.evaluate();
  assert.equal(out.error, null);
  assert.equal(out.nodes.R1.status, 'valid');
  assert.equal(out.nodes.R1.chosenBatch, 'B1');
  assert.equal(out.nodes.R1.invalidationPath, null);
});

test('multiple valid substitutes choose smallest batch id deterministically', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B3', protocolVersion: 'v1', substitutes: ['B2', 'B1'] });
  const out = lab.evaluate();
  assert.equal(out.nodes.R1.status, 'valid');
  assert.equal(out.nodes.R1.chosenBatch, 'B1');
});

test('concentration correction invalidates and falls back to smallest valid substitute', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1', substitutes: ['B3', 'B2'] });
  lab.apply({ op: 'correctConcentration', id: 'B1', concentration: 1.5 });
  const out = lab.evaluate();
  assert.equal(out.nodes.R1.status, 'valid');
  assert.equal(out.nodes.R1.chosenBatch, 'B2');
});

test('withdrawal and expiry invalidate a batch', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
  lab.apply({ op: 'addResult', id: 'R2', batchId: 'B2', protocolVersion: 'v1' });
  lab.apply({ op: 'withdrawBatch', id: 'B1' });
  lab.apply({ op: 'setNow', now: '2027-06-01' });
  const out = lab.evaluate();
  assert.equal(out.nodes.R1.status, 'invalid');
  assert.deepEqual(out.nodes.R1.cause, { type: 'batch', batches: [{ id: 'B1', problems: ['withdrawn', 'expired'] }] });
  assert.equal(out.nodes.R2.status, 'invalid');
  assert.deepEqual(out.nodes.R2.cause.batches[0].problems, ['expired']);
});

test('invalidation propagates through derived, chart and conclusion nodes', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
  lab.apply({ op: 'addNode', id: 'D1', kind: 'derived', dependsOn: ['R1'] });
  lab.apply({ op: 'addNode', id: 'C1', kind: 'chart', dependsOn: ['D1'] });
  lab.apply({ op: 'addNode', id: 'K1', kind: 'conclusion', dependsOn: ['C1'] });
  lab.apply({ op: 'withdrawBatch', id: 'B1' });
  const out = lab.evaluate();
  for (const id of ['R1', 'D1', 'C1', 'K1']) assert.equal(out.nodes[id].status, 'invalid', id);
  assert.deepEqual(out.nodes.K1.invalidationPath, ['R1', 'D1', 'C1', 'K1']);
  assert.equal(out.status, 'invalid');
});

test('dynamic substitute add/remove keeps conclusion valid iff a valid substitute exists', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
  lab.apply({ op: 'addNode', id: 'K1', kind: 'conclusion', dependsOn: ['R1'] });
  lab.apply({ op: 'withdrawBatch', id: 'B1' });
  assert.equal(lab.evaluate().nodes.K1.status, 'invalid');
  lab.apply({ op: 'addSubstitute', id: 'R1', batchId: 'B2' });
  assert.equal(lab.evaluate().nodes.K1.status, 'valid');
  assert.equal(lab.evaluate().nodes.R1.chosenBatch, 'B2');
  lab.apply({ op: 'removeSubstitute', id: 'R1', batchId: 'B2' });
  assert.equal(lab.evaluate().nodes.K1.status, 'invalid');
});

test('all substitutes invalid => invalid with null chosen batch and batch cause', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1', substitutes: ['B2', 'B3'] });
  lab.apply({ op: 'withdrawBatch', id: 'B1' });
  lab.apply({ op: 'correctConcentration', id: 'B2', concentration: 9 });
  lab.apply({ op: 'withdrawBatch', id: 'B3' });
  const out = lab.evaluate();
  assert.equal(out.nodes.R1.status, 'invalid');
  assert.equal(out.nodes.R1.chosenBatch, null);
  assert.deepEqual(out.nodes.R1.invalidationPath, ['R1']);
  assert.equal(out.nodes.R1.cause.type, 'batch');
  assert.equal(out.nodes.R1.cause.batches.length, 3);
});

test('dependency cycle returns E_CYCLE', () => {
  const lab = baseLab();
  lab.apply({ op: 'addNode', id: 'A', kind: 'derived', dependsOn: ['B'] });
  lab.apply({ op: 'addNode', id: 'B', kind: 'derived', dependsOn: ['A'] });
  const out = lab.evaluate();
  assert.equal(out.error.code, 'E_CYCLE');
  assert.ok(out.error.cycle.includes('A'));
  assert.ok(out.error.cycle.includes('B'));
});

test('unknown batch reference returns E_REF', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'NOPE', protocolVersion: 'v1' });
  const out = lab.evaluate();
  assert.equal(out.error.code, 'E_REF');
  assert.equal(out.error.ref, 'NOPE');
  lab.apply({ op: 'addSubstitute', id: 'R1', batchId: 'ALSO_NOPE' });
  assert.equal(lab.evaluate().error.code, 'E_REF');
});

test('undo and redo restore previous validity and certificates', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
  const before = lab.evaluate();
  lab.apply({ op: 'withdrawBatch', id: 'B1' });
  assert.equal(lab.evaluate().nodes.R1.status, 'invalid');
  const undoOut = lab.undo();
  assert.equal(undoOut.ok, true);
  const restored = lab.evaluate();
  assert.equal(restored.nodes.R1.status, 'valid');
  assert.deepEqual(restored, before);
  lab.redo();
  assert.equal(lab.evaluate().nodes.R1.status, 'invalid');
});

test('undo/redo across substitute edits', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
  lab.apply({ op: 'withdrawBatch', id: 'B1' });
  lab.apply({ op: 'addSubstitute', id: 'R1', batchId: 'B2' });
  assert.equal(lab.evaluate().nodes.R1.status, 'valid');
  lab.undo();
  assert.equal(lab.evaluate().nodes.R1.status, 'invalid');
  lab.redo();
  assert.equal(lab.evaluate().nodes.R1.status, 'valid');
  assert.equal(lab.evaluate().nodes.R1.chosenBatch, 'B2');
});

test('empty protocol version is invalid with empty_protocol cause; empty lab is valid', () => {
  const lab = new Lab();
  const empty = lab.evaluate();
  assert.equal(empty.error, null);
  assert.equal(empty.status, 'valid');
  assert.deepEqual(empty.nodes, {});
  lab.apply({ op: 'addBatch', id: 'B1' });
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: '' });
  const out = lab.evaluate();
  assert.equal(out.nodes.R1.status, 'invalid');
  assert.deepEqual(out.nodes.R1.cause, { type: 'empty_protocol' });
  assert.deepEqual(out.nodes.R1.invalidationPath, ['R1']);
});

test('correcting a shared batch only affects its reachable closure', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
  lab.apply({ op: 'addResult', id: 'R2', batchId: 'B2', protocolVersion: 'v1' });
  lab.apply({ op: 'addResult', id: 'R3', batchId: 'B1', protocolVersion: 'v1', substitutes: ['B3'] });
  lab.apply({ op: 'addNode', id: 'D1', kind: 'derived', dependsOn: ['R1'] });
  lab.apply({ op: 'addNode', id: 'D2', kind: 'derived', dependsOn: ['R2'] });
  lab.apply({ op: 'addNode', id: 'C1', kind: 'chart', dependsOn: ['D1', 'D2'] });
  lab.apply({ op: 'addNode', id: 'K1', kind: 'conclusion', dependsOn: ['C1'] });
  const before = lab.evaluate();
  const res = lab.apply({ op: 'correctConcentration', id: 'B1', concentration: 1.1 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.affected, ['C1', 'D1', 'K1', 'R1', 'R3']);
  const after = lab.evaluate();
  for (const id of ['R2', 'D2']) {
    assert.deepEqual(after.nodes[id], before.nodes[id], id + ' must be untouched');
  }
  assert.equal(after.nodes.R3.status, 'valid');
  assert.equal(after.nodes.R3.chosenBatch, 'B3');
  assert.equal(after.nodes.R1.status, 'invalid');
});

test('certificates contain chosen batch, invalidation path and state hash', () => {
  const lab = baseLab();
  lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
  lab.apply({ op: 'addNode', id: 'K1', kind: 'conclusion', dependsOn: ['R1'] });
  lab.apply({ op: 'withdrawBatch', id: 'B1' });
  const cert = lab.evaluate().nodes.K1.certificate;
  assert.equal(cert.nodeId, 'K1');
  assert.equal(cert.status, 'invalid');
  assert.equal(cert.chosenBatch, null);
  assert.deepEqual(cert.invalidationPath, ['R1', 'K1']);
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
  const validCert = baseLab().evaluate().stateHash;
  assert.match(validCert, /^[0-9a-f]{64}$/);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzScenario(seed) {
  const rng = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const lab = new Lab();
  const batches = [];
  const results = [];
  const others = [];
  const allNodes = () => [...results, ...others];

  lab.apply({ op: 'setNow', now: '2026-01-01' });
  const nBatches = 1 + Math.floor(rng() * 8);
  for (let i = 0; i < nBatches; i++) {
    const id = 'B' + i;
    batches.push(id);
    lab.apply({
      op: 'addBatch',
      id,
      expiresAt: pick(['2026-06-01', '2027-01-01', '2028-01-01', null]),
      concentration: Math.floor(rng() * 10),
    });
  }
  const nResults = 1 + Math.floor(rng() * 8);
  for (let i = 0; i < nResults; i++) {
    const id = 'R' + i;
    results.push(id);
    const subs = batches.filter(() => rng() < 0.35);
    lab.apply({
      op: 'addResult',
      id,
      batchId: pick(batches),
      protocolVersion: rng() < 0.1 ? '' : 'v' + (1 + Math.floor(rng() * 3)),
      substitutes: subs,
    });
  }
  const nOthers = Math.floor(rng() * 5);
  for (let i = 0; i < nOthers; i++) {
    const id = 'N' + i;
    others.push(id);
    const deps = allNodes().filter((d) => d !== id && rng() < 0.4);
    lab.apply({ op: 'addNode', id, kind: pick(['derived', 'chart', 'conclusion']), dependsOn: deps });
  }

  const compare = (label) => {
    const actual = lab.evaluate();
    const expected = referenceEvaluate(replay(lab.events, lab.cursor));
    if (actual.error || expected.error) {
    assert.deepEqual(
        actual.error ? { code: actual.error.code } : null,
        expected.error ? { code: expected.error.code } : null,
        label + ': error mismatch'
      );
      return;
    }
    assert.equal(actual.status, expected.status, label + ': overall status');
    for (const id of Object.keys(expected.nodes)) {
      assert.equal(actual.nodes[id].status, expected.nodes[id].status, label + ': status of ' + id);
      assert.deepEqual(actual.nodes[id].chosenBatch, expected.nodes[id].chosenBatch, label + ': chosen of ' + id);
      assert.deepEqual(
        actual.nodes[id].invalidationPath,
        expected.nodes[id].invalidationPath,
        label + ': path of ' + id
      );
    }
  };

  compare('seed ' + seed + ' initial');
  for (let step = 0; step < 40; step++) {
    const roll = rng();
    if (roll < 0.2) {
      lab.apply({ op: 'correctConcentration', id: pick(batches), concentration: Math.floor(rng() * 20) });
    } else if (roll < 0.35) {
      lab.apply({ op: 'withdrawBatch', id: pick(batches) });
    } else if (roll < 0.5) {
      lab.apply({ op: 'addSubstitute', id: pick(results), batchId: pick(batches) });
    } else if (roll < 0.6) {
      lab.apply({ op: 'removeSubstitute', id: pick(results), batchId: pick(batches) });
    } else if (roll < 0.7) {
      lab.apply({ op: 'setNow', now: pick(['2026-01-01', '2026-07-01', '2027-06-01', '2029-01-01']) });
    } else if (roll < 0.8 && others.length > 0) {
      const target = pick(others);
      const dep = pick(allNodes());
      if (target !== dep) lab.apply({ op: 'addDependency', id: target, dependsOn: dep });
    } else if (roll < 0.9) {
      lab.undo();
    } else {
      lab.redo();
    }
    compare('seed ' + seed + ' step ' + step);
  }
}

test('fuzz: incremental evaluation matches brute-force reference (<=8 batches, <=8 results)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) fuzzScenario(seed);
});
