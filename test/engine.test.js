import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const NOW = 1_000_000;

function makeEngine() {
  const e = new Engine({ now: NOW });
  e.addBatch({ id: 'b1', concentration: 1.0, expiry: NOW + 10_000 });
  e.addBatch({ id: 'b2', concentration: 2.0, expiry: NOW + 10_000 });
  e.addBatch({ id: 'b3', concentration: 3.0, expiry: NOW + 10_000 });
  return e;
}

test('valid result chooses primary batch', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  assert.equal(e.status('r1').value.status, 'valid');
  assert.equal(e.status('r1').value.chosenBatch, 'b1');
});

test('expired batch invalidates result and propagates to chart and conclusion', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  e.addNode({ id: 'c1', kind: 'chart', deps: ['r1'] });
  e.addNode({ id: 'k1', kind: 'conclusion', deps: ['c1'] });
  e.setExpiry('b1', NOW - 1);
  assert.equal(e.status('r1').value.status, 'invalid');
  assert.equal(e.status('r1').value.reason, 'expired');
  assert.equal(e.status('c1').value.status, 'invalid');
  assert.equal(e.status('k1').value.status, 'invalid');
  assert.deepEqual(e.status('k1').value.invalidationPath, ['b1', 'r1', 'c1', 'k1']);
});

test('withdrawal and concentration correction invalidate dependent results', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  e.addResult({ id: 'r2', batch: 'b2', protocol: 'p1' });
  e.withdrawBatch('b1');
  e.correctConcentration('b2', 2.5);
  assert.equal(e.status('r1').value.reason, 'withdrawn');
  assert.equal(e.status('r2').value.reason, 'concentration_corrected');
});

test('multiple valid substitutes: smallest batch id wins', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b3', protocol: 'p1' });
  e.addSubstitute('r1', 'b2');
  e.addSubstitute('r1', 'b1');
  e.withdrawBatch('b3');
  assert.equal(e.status('r1').value.status, 'valid');
  assert.equal(e.status('r1').value.chosenBatch, 'b1');
  e.withdrawBatch('b1');
  assert.equal(e.status('r1').value.chosenBatch, 'b2');
});

test('dynamic substitute add/remove flips conclusion validity', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  e.addNode({ id: 'k1', kind: 'conclusion', deps: ['r1'] });
  e.withdrawBatch('b1');
  assert.equal(e.status('k1').value.status, 'invalid');
  e.addSubstitute('r1', 'b2');
  assert.equal(e.status('k1').value.status, 'valid');
  assert.equal(e.status('r1').value.chosenBatch, 'b2');
  e.removeSubstitute('r1', 'b2');
  assert.equal(e.status('k1').value.status, 'invalid');
});

test('all substitutes invalid -> invalid with deterministic cause path', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b3', protocol: 'p1' });
  e.addSubstitute('r1', 'b2');
  e.addSubstitute('r1', 'b1');
  e.withdrawBatch('b1');
  e.withdrawBatch('b2');
  e.withdrawBatch('b3');
  const s = e.status('r1').value;
  assert.equal(s.status, 'invalid');
  assert.equal(s.chosenBatch, null);
  assert.deepEqual(s.invalidationPath, ['b1', 'r1']);
});

test('cycle returns E_CYCLE and leaves state unchanged', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  e.addNode({ id: 'c1', kind: 'chart', deps: ['r1'] });
  e.addNode({ id: 'c2', kind: 'chart', deps: ['c1'] });
  const r = e.addEdge('r1', 'c2');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_CYCLE');
  const self = e.addEdge('c1', 'c1');
  assert.equal(self.error.code, 'E_CYCLE');
  assert.equal(e.status('c2').value.status, 'valid');
});

test('unknown batch returns E_REF', () => {
  const e = makeEngine();
  assert.equal(e.addResult({ id: 'r1', batch: 'nope', protocol: 'p1' }).error.code, 'E_REF');
  assert.equal(e.withdrawBatch('nope').error.code, 'E_REF');
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  assert.equal(e.addSubstitute('r1', 'nope').error.code, 'E_REF');
  assert.equal(e.status('nope').error.code, 'E_REF');
});

test('undo restores invalid state, redo reapplies correction', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  const hashBefore = e.stateHash();
  e.correctConcentration('b1', 9.9);
  assert.equal(e.status('r1').value.status, 'invalid');
  const hashAfter = e.stateHash();
  assert.notEqual(hashBefore, hashAfter);
  assert.equal(e.undo().ok, true);
  assert.equal(e.status('r1').value.status, 'valid');
  assert.equal(e.stateHash(), hashBefore);
  assert.equal(e.redo().ok, true);
  assert.equal(e.status('r1').value.status, 'invalid');
  assert.equal(e.stateHash(), hashAfter);
});

test('undo of substitute removal restores validity', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  e.addSubstitute('r1', 'b2');
  e.withdrawBatch('b1');
  assert.equal(e.status('r1').value.status, 'valid');
  e.removeSubstitute('r1', 'b2');
  assert.equal(e.status('r1').value.status, 'invalid');
  e.undo();
  assert.equal(e.status('r1').value.status, 'valid');
  assert.equal(e.status('r1').value.chosenBatch, 'b2');
});

test('empty protocol yields agreed invalid result', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: '' });
  const s = e.status('r1').value;
  assert.equal(s.status, 'invalid');
  assert.equal(s.reason, 'empty_protocol');
  assert.deepEqual(s.invalidationPath, ['r1']);
});

test('certificate carries chosen batch, invalidation path and state hash', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  e.addNode({ id: 'k1', kind: 'conclusion', deps: ['r1'] });
  const cert = e.certificate('k1').value;
  assert.equal(cert.status, 'valid');
  assert.deepEqual(cert.choices, { r1: 'b1' });
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
  e.withdrawBatch('b1');
  const cert2 = e.certificate('k1').value;
  assert.equal(cert2.status, 'invalid');
  assert.deepEqual(cert2.invalidationPath, ['b1', 'r1', 'k1']);
  assert.notEqual(cert2.stateHash, cert.stateHash);
});

test('correcting a shared batch only affects its reachable closure', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  e.addResult({ id: 'r2', batch: 'b2', protocol: 'p1' });
  e.addNode({ id: 'c1', kind: 'chart', deps: ['r1'] });
  e.addNode({ id: 'c2', kind: 'chart', deps: ['r2'] });
  e.addNode({ id: 'k1', kind: 'conclusion', deps: ['c1', 'c2'] });
  const hashR2 = JSON.stringify(e.status('r2').value);
  const hashC2 = JSON.stringify(e.status('c2').value);
  e.correctConcentration('b1', 7.7);
  assert.deepEqual(e.lastAffected(), ['c1', 'k1', 'r1']);
  assert.equal(e.status('r1').value.status, 'invalid');
  assert.equal(e.status('c1').value.status, 'invalid');
  assert.equal(e.status('k1').value.status, 'invalid');
  assert.equal(JSON.stringify(e.status('r2').value), hashR2);
  assert.equal(JSON.stringify(e.status('c2').value), hashC2);
  assert.equal(e.status('r2').value.status, 'valid');
});

test('substitute edge change only affects its own closure', () => {
  const e = makeEngine();
  e.addResult({ id: 'r1', batch: 'b1', protocol: 'p1' });
  e.addResult({ id: 'r2', batch: 'b2', protocol: 'p1' });
  e.addSubstitute('r1', 'b3');
  assert.deepEqual(e.lastAffected(), ['r1']);
});

test('undo/redo with empty stacks report E_UNDO', () => {
  const e = new Engine({ now: NOW });
  assert.equal(e.undo().error.code, 'E_UNDO');
  assert.equal(e.redo().error.code, 'E_UNDO');
});
