// Acceptance 1: random histories of <= 9 steps, verifier cross-checked
// against the reference automaton.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/verifier.js';
import { run } from '../src/machine.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CMDS = [
  'close_door',
  'lock_door',
  'unlock_door',
  'open_door',
  'heat_on',
  'heat_off',
  'open_vent',
  'close_vent',
  'poke', // unknown command on purpose
];

const ACKS = [
  { sensor: 'pressure', value: 'HIGH' },
  { sensor: 'pressure', value: 'LOW' },
  { sensor: 'door', value: 'LOCKED' },
  { sensor: 'co2', value: 'HIGH' }, // unknown sensor on purpose
];

function randomEvent(rnd) {
  if (rnd() < 0.6) {
    return { type: 'cmd', name: CMDS[Math.floor(rnd() * CMDS.length)] };
  }
  return { type: 'ack', ...ACKS[Math.floor(rnd() * ACKS.length)] };
}

test('random histories (<=9 steps) match the reference automaton', () => {
  const SEEDS = 5000;
  let violations = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const rnd = mulberry32(seed);
    const len = Math.floor(rnd() * 10); // 0..9 steps
    const events = Array.from({ length: len }, () => randomEvent(rnd));

    const v = verify(events);
    const ref = run(events);

    assert.equal(v.verdict, ref.verdict, `seed=${seed} events=${JSON.stringify(events)}`);
    assert.equal(
      v.violation ? v.violation.index : -1,
      ref.violationIndex,
      `seed=${seed} events=${JSON.stringify(events)}`,
    );
    assert.deepEqual(v.safeState, ref.state, `seed=${seed} events=${JSON.stringify(events)}`);
    if (v.verdict === 'VIOLATION') {
      violations += 1;
      // minimalViolation must be exactly the minimal prefix
      assert.deepEqual(v.minimalViolation, events.slice(0, ref.violationIndex + 1));
      assert.equal(verify(v.minimalViolation.slice(0, -1)).verdict, 'OK');
    } else {
      assert.equal(v.minimalViolation, null);
    }
  }
  assert.ok(violations > SEEDS / 4, `expected a healthy mix of verdicts, got ${violations}/${SEEDS} violations`);
});
