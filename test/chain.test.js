import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationChain, ERRORS } from '../src/chain.js';

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function err(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code);
  return result;
}

test('empty graph is stable', () => {
  const chain = new CalibrationChain();
  const snap = chain.snapshot();
  assert.equal(snap.version, 0);
  assert.deepEqual(snap.results, {});
  assert.deepEqual(snap.certificate.ordering, []);
  assert.match(snap.certificate.coefficientsHash, /^[0-9a-f]{64}$/);
  assert.match(snap.certificate.topologyHash, /^[0-9a-f]{64}$/);
  err(chain.undo(), ERRORS.E_UNDO_EMPTY);
  err(chain.redo(), ERRORS.E_REDO_EMPTY);
  err(chain.getResult('nope'), ERRORS.E_UNKNOWN_SENSOR);
  // Certificate of an empty graph is deterministic.
  assert.deepEqual(chain.certificate(), snap.certificate);
});

test('calibration applies y = x * scale + offset along the chain', () => {
  const chain = new CalibrationChain();
  ok(chain.addSensor('a', { raw: 1, offset: 1, scale: 2 }));
  ok(chain.addSensor('b', { raw: 0, offset: 0, scale: 3 }));
  ok(chain.addSensor('c', { raw: 0, offset: -4, scale: 0.5 }));
  ok(chain.addCalibration('b', 'a'));
  ok(chain.addCalibration('c', 'b'));
  const a = ok(chain.getResult('a')).result;
  const b = ok(chain.getResult('b')).result;
  const c = ok(chain.getResult('c')).result;
  assert.equal(a.value, 1 * 2 + 1);
  assert.equal(b.value, a.value * 3 + 0);
  assert.equal(c.value, b.value * 0.5 - 4);
  assert.equal(a.confidence, 1);
  assert.equal(b.blocked, false);
  assert.equal(c.version, chain.version);
  assert.deepEqual(chain.certificate().ordering, ['a', 'b', 'c']);
});

test('duplicate calibration base returns E_TOPO', () => {
  const chain = new CalibrationChain();
  ok(chain.addSensor('a', { raw: 1, offset: 0, scale: 1 }));
  ok(chain.addSensor('b', { raw: 2, offset: 0, scale: 1 }));
  ok(chain.addSensor('c', { raw: 3, offset: 0, scale: 1 }));
  ok(chain.addCalibration('a', 'b'));
  err(chain.addCalibration('a', 'c'), ERRORS.E_TOPO);
  // Failed op must not mutate state or history.
  assert.equal(chain.getState().bases.a, 'b');
  ok(chain.undo());
  ok(chain.redo());
  assert.equal(chain.getState().bases.a, 'b');
});

test('cycles return E_CYCLE', () => {
  const chain = new CalibrationChain();
  for (const id of ['a', 'b', 'c']) {
    ok(chain.addSensor(id, { raw: 1, offset: 0, scale: 1 }));
  }
  err(chain.addCalibration('a', 'a'), ERRORS.E_CYCLE);
  ok(chain.addCalibration('a', 'b'));
  ok(chain.addCalibration('b', 'c'));
  err(chain.addCalibration('c', 'a'), ERRORS.E_CYCLE);
  err(chain.addCalibration('c', 'b'), ERRORS.E_CYCLE);
  // State unchanged by rejected edges.
  assert.deepEqual(chain.getState().bases, { a: 'b', b: 'c' });
});

test('missing base blocks the sensor and its dependents', () => {
  const chain = new CalibrationChain();
  ok(chain.addSensor('a', { raw: 1, offset: 0, scale: 1 }));
  ok(chain.addSensor('b', { raw: 2, offset: 0, scale: 1 }));
  ok(chain.addCalibration('a', 'ghost'));
  ok(chain.addCalibration('b', 'a'));
  const a = ok(chain.getResult('a')).result;
  const b = ok(chain.getResult('b')).result;
  assert.equal(a.blocked, true);
  assert.equal(a.value, null);
  assert.equal(a.confidence, 0);
  assert.equal(b.blocked, true);
  assert.equal(b.confidence, 0);
  // Adding the missing base unblocks the chain.
  ok(chain.addSensor('ghost', { raw: 5, offset: 1, scale: 2 }));
  assert.equal(ok(chain.getResult('a')).result.blocked, false);
  assert.equal(ok(chain.getResult('a')).result.value, 5 * 2 + 1);
  assert.equal(ok(chain.getResult('b')).result.value, 5 * 2 + 1);
});

test('removing a sensor blocks its dependents; undo restores', () => {
  const chain = new CalibrationChain();
  ok(chain.addSensor('a', { raw: 1, offset: 0, scale: 1 }));
  ok(chain.addSensor('b', { raw: 0, offset: 1, scale: 2 }));
  ok(chain.addCalibration('b', 'a'));
  assert.equal(ok(chain.getResult('b')).result.value, 3);
  ok(chain.removeSensor('a'));
  const b = ok(chain.getResult('b')).result;
  assert.equal(b.blocked, true);
  assert.equal(b.confidence, 0);
  ok(chain.undo());
  assert.equal(ok(chain.getResult('b')).result.value, 3);
});

test('changing base invalidates the old chain and joins the new one', () => {
  const chain = new CalibrationChain();
  ok(chain.addSensor('a', { raw: 1, offset: 0, scale: 10 }));
  ok(chain.addSensor('c', { raw: 1, offset: 0, scale: 100 }));
  ok(chain.addSensor('b', { raw: 0, offset: 0, scale: 1 }));
  ok(chain.addCalibration('b', 'a'));
  assert.equal(ok(chain.getResult('b')).result.value, 10);
  // Rebase b from a onto c.
  ok(chain.removeCalibration('b'));
  ok(chain.addCalibration('b', 'c'));
  assert.equal(ok(chain.getResult('b')).result.value, 100);
  // Correcting the old base no longer affects b.
  chain.snapshot();
  chain.recomputeCount = 0;
  ok(chain.setCoefficients('a', { scale: 20 }));
  chain.snapshot();
  assert.equal(chain.recomputeCount, 1, 'only a is recomputed');
  assert.equal(ok(chain.getResult('b')).result.value, 100);
  // Correcting the new base propagates to b.
  chain.recomputeCount = 0;
  ok(chain.setCoefficients('c', { scale: 7 }));
  chain.snapshot();
  assert.equal(chain.recomputeCount, 2, 'c and b are recomputed');
  assert.equal(ok(chain.getResult('b')).result.value, 7);
});

test('coefficient correction only recomputes the affected closure', () => {
  const chain = new CalibrationChain();
  ok(chain.addSensor('a', { raw: 1, offset: 0, scale: 1 }));
  ok(chain.addSensor('b', { raw: 0, offset: 0, scale: 1 }));
  ok(chain.addSensor('c', { raw: 0, offset: 0, scale: 1 }));
  ok(chain.addSensor('d', { raw: 9, offset: 0, scale: 1 }));
  ok(chain.addCalibration('b', 'a'));
  ok(chain.addCalibration('c', 'b'));
  chain.snapshot();
  chain.recomputeCount = 0;
  ok(chain.setCoefficients('a', { offset: 5 }));
  chain.snapshot();
  assert.equal(chain.recomputeCount, 3, 'a, b, c recomputed; d untouched');
  chain.recomputeCount = 0;
  ok(chain.setCoefficients('b', { offset: 1 }));
  chain.snapshot();
  assert.equal(chain.recomputeCount, 2, 'b, c recomputed');
});

test('undo to initial state, redo, and redo-stack invalidation', () => {
  const chain = new CalibrationChain();
  const initial = chain.snapshot();
  ok(chain.addSensor('a', { raw: 1, offset: 2, scale: 3 }));
  ok(chain.addSensor('b', { raw: 4, offset: 5, scale: 6 }));
  ok(chain.addCalibration('b', 'a'));
  ok(chain.setCoefficients('a', { offset: 10 }));
  assert.equal(chain.version, 4);
  // Undo everything back to the initial state.
  for (let i = 0; i < 4; i++) ok(chain.undo());
  err(chain.undo(), ERRORS.E_UNDO_EMPTY);
  assert.equal(chain.version, 0);
  assert.deepEqual(chain.snapshot(), initial);
  // Redo two steps, then a new correction clears the redo stack.
  ok(chain.redo());
  ok(chain.redo());
  ok(chain.setCoefficients('a', { raw: 7 }));
  err(chain.redo(), ERRORS.E_REDO_EMPTY);
  assert.equal(chain.getState().sensors.a.raw, 7);
  // Undo remains possible.
  ok(chain.undo());
  assert.equal(chain.getState().sensors.a.raw, 1);
});

test('undo/redo round-trips calibration topology and certificates', () => {
  const chain = new CalibrationChain();
  ok(chain.addSensor('a', { raw: 1, offset: 0, scale: 2 }));
  ok(chain.addSensor('b', { raw: 0, offset: 1, scale: 1 }));
  ok(chain.addCalibration('b', 'a'));
  const before = chain.snapshot();
  ok(chain.removeCalibration('b'));
  assert.notDeepEqual(chain.certificate(), before.certificate);
  ok(chain.undo());
  assert.deepEqual(chain.snapshot(), before);
  ok(chain.redo());
  assert.equal(chain.getState().bases.b, undefined);
  ok(chain.undo());
  assert.deepEqual(chain.snapshot(), before);
});

test('version increments only on successful mutations', () => {
  const chain = new CalibrationChain();
  ok(chain.addSensor('a', { raw: 1, offset: 0, scale: 1 }));
  const v = chain.version;
  err(chain.addSensor('a', { raw: 0, offset: 0, scale: 1 }), ERRORS.E_SENSOR_EXISTS);
  err(chain.setCoefficients('ghost', { raw: 1 }), ERRORS.E_UNKNOWN_SENSOR);
  err(chain.removeSensor('ghost'), ERRORS.E_UNKNOWN_SENSOR);
  err(chain.removeCalibration('a'), ERRORS.E_NO_BASE);
  err(chain.addSensor('bad', { raw: Number.NaN, offset: 0, scale: 1 }), ERRORS.E_INVALID);
  assert.equal(chain.version, v);
});
