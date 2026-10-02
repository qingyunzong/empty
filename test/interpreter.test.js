'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Interpreter, TEACH_SPEED_LIMIT, DECEL_TICKS } = require('../src/interpreter');

test('permission inherits team -> station -> robot', () => {
  const interp = new Interpreter();
  // robot-level key alone cannot switch modes (needs station scope)
  interp.run([
    { clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'R1', level: 'robot' },
    { clock: 2, seq: 2, source: 'hmi', type: 'mode_request', mode: 'auto' },
  ]);
  assert.equal(interp.mode, 'maintenance');
  assert.match(interp.violations.at(-1).reason, /station scope/);
  // team key inherits down to station and robot scopes
  interp.run([
    { clock: 3, seq: 3, source: 'hmi', type: 'key_grant', key: 'T1', level: 'team' },
    { clock: 4, seq: 4, source: 'hmi', type: 'mode_request', mode: 'auto' },
    { clock: 5, seq: 5, source: 'plc', type: 'auto_start' },
  ]);
  assert.equal(interp.mode, 'auto');
  assert.equal(interp.running, true);
  // revoking the team key leaves the robot key: robot scope still permitted
  interp.run([{ clock: 6, seq: 6, source: 'keys', type: 'key_revoke', key: 'T1' }]);
  assert.equal(interp.hasPermission('robot'), true);
  assert.equal(interp.hasPermission('station'), false);
  assert.equal(interp.decel, null, 'no decel: robot-scope permission still present');
});

test('teach speed limit (safety) overrides throughput request', () => {
  const interp = new Interpreter();
  interp.run([
    { clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'T1', level: 'team' },
    { clock: 2, seq: 2, source: 'hmi', type: 'mode_request', mode: 'teach' },
    { clock: 3, seq: 3, source: 'mps', type: 'speed_request', mm_s: 1200 },
  ]);
  assert.equal(interp.speedLimit, TEACH_SPEED_LIMIT);
  const v = interp.violations.at(-1);
  assert.equal(v.kind, 'violation');
  assert.match(v.reason, /safety speed limit 250 mm\/s overrides throughput request 1200/);
});

test('key revocation is immediate; started decel window completes without jumps', () => {
  const interp = new Interpreter();
  interp.run([
    { clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'T1', level: 'team' },
    { clock: 2, seq: 2, source: 'hmi', type: 'mode_request', mode: 'auto' },
    { clock: 3, seq: 3, source: 'plc', type: 'auto_start' },
  ]);
  assert.equal(interp.running, true);
  interp.run([{ clock: 4, seq: 4, source: 'keys', type: 'key_revoke', key: 'T1' }]);
  assert.equal(interp.hasPermission('robot'), false, 'revocation effective immediately');
  assert.equal(interp.running, false);
  assert.deepEqual(
    { start: interp.decel.start, end: interp.decel.end },
    { start: 4, end: 4 + DECEL_TICKS },
  );
  assert.equal(interp.mode, 'auto', 'no mid-window jump');
  // mode change requested inside the window is discarded
  interp.run([{ clock: 5, seq: 5, source: 'hmi', type: 'mode_request', mode: 'teach' }]);
  assert.equal(interp.mode, 'auto');
  assert.equal(interp.violations.at(-1).kind, 'discarded');
  assert.match(interp.violations.at(-1).reason, /deceleration window in progress/);
  // window completes at clock >= end
  interp.run([{ clock: 6, seq: 6, source: 'door', type: 'door', state: 'closed' }]);
  assert.equal(interp.decel, null);
  assert.equal(interp.mode, 'maintenance');
  assert.ok(interp.transitions.some((t) => t.transition === 'decel_completed'));
});

test('same-clock conflict: higher safety level wins, loser discarded with reason', () => {
  const interp = new Interpreter();
  interp.run([
    { clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'T1', level: 'team' },
    { clock: 2, seq: 2, source: 'hmi', type: 'mode_request', mode: 'auto' },
    // same logical clock, arriving in adversarial order:
    { clock: 3, seq: 3, source: 'plc', type: 'auto_start' },
    { clock: 3, seq: 4, source: 'door', type: 'door', state: 'open' },
  ]);
  assert.equal(interp.running, false);
  assert.equal(interp.door, 'open');
  const discarded = interp.violations.filter((v) => v.kind === 'discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].event.type, 'auto_start');
  assert.match(discarded[0].reason, /door open|deceleration window/);
});
