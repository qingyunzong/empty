// Acceptance 2 & 4: interlock violation with minimal prefix; unknown acks
// never turn UNKNOWN into safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/verifier.js';

const cmd = (name) => ({ type: 'cmd', name });
const ack = (sensor, value) => ({ type: 'ack', sensor, value });

test('heating without confirmed pressure, then open_vent -> VIOLATION with minimal prefix', () => {
  const history = [cmd('close_door'), cmd('lock_door'), cmd('heat_on'), cmd('open_vent')];
  const r = verify(history);

  assert.equal(r.verdict, 'VIOLATION');
  assert.equal(r.violation.kind, 'INTERLOCK');
  assert.equal(r.violation.index, 3);
  assert.deepEqual(r.violation.event, cmd('open_vent'));
  assert.match(r.violation.reason, /pressure HIGH/);

  // minimal prefix is the whole history; every proper prefix is OK
  assert.deepEqual(r.minimalViolation, history);
  for (let i = 0; i < history.length; i += 1) {
    assert.equal(verify(history.slice(0, i)).verdict, 'OK', `prefix of length ${i} must be OK`);
  }

  // safeState is the deterministic state just before the violating command
  assert.deepEqual(r.safeState, { door: 'LOCKED', heat: 'ON', vent: 'CLOSED', pressure: 'UNKNOWN' });
});

test('full valid cycle is OK', () => {
  const history = [
    cmd('close_door'),
    cmd('lock_door'),
    cmd('heat_on'),
    ack('pressure', 'HIGH'),
    cmd('open_vent'),
    ack('pressure', 'LOW'),
    cmd('heat_off'),
    cmd('close_vent'),
    cmd('unlock_door'),
    cmd('open_door'),
  ];
  const r = verify(history);
  assert.equal(r.verdict, 'OK');
  assert.deepEqual(r.safeState, { door: 'OPEN', heat: 'OFF', vent: 'CLOSED', pressure: 'LOW' });
});

test('unknown ack keeps pressure UNKNOWN and is never judged safe', () => {
  const history = [
    cmd('close_door'),
    cmd('lock_door'),
    cmd('heat_on'),
    ack('co2', 'HIGH'), // unknown sensor: recorded but meaningless
    cmd('open_vent'),
  ];
  const r = verify(history);
  assert.equal(r.verdict, 'VIOLATION');
  assert.equal(r.violation.index, 4);
  assert.equal(r.safeState.pressure, 'UNKNOWN');

  // the unknown ack alone changes nothing
  const beforeAck = verify(history.slice(0, 3));
  const afterAck = verify(history.slice(0, 4));
  assert.deepEqual(afterAck.safeState, beforeAck.safeState);
});

test('ack without causal command is a CAUSALITY violation (linearization)', () => {
  const r = verify([cmd('close_door'), ack('pressure', 'HIGH')]);
  assert.equal(r.verdict, 'VIOLATION');
  assert.equal(r.violation.kind, 'CAUSALITY');
  assert.equal(r.violation.index, 1);
  assert.deepEqual(r.minimalViolation, [cmd('close_door'), ack('pressure', 'HIGH')]);
});
