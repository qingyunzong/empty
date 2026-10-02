import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, minimalViolation } from '../src/machine.js';
import { verify } from '../src/verify.js';

const cmd = (name) => ({ type: 'cmd', name });
const ack = (sensor, value) => ({ type: 'ack', sensor, value });

test('完整安全流程: 关门-升温-达压-停热-排汽-泄压-开门', () => {
  const h = [
    cmd('LOCK_DOOR'), ack('DOOR', 'LOCKED'),
    cmd('START_HEAT'), ack('PRESSURE', 'OK'), ack('TEMP', 'OK'),
    cmd('STOP_HEAT'),
    cmd('OPEN_EXHAUST'),
    ack('PRESSURE', 'ZERO'),
    cmd('OPEN_DOOR'),
  ];
  const r = evaluate(h);
  assert.equal(r.verdict, 'SAFE');
  assert.equal(r.safeState.isSafe, true);
  assert.equal(r.safeState.phase, 'IDLE');
});

test('验收2: 升温未达压强却开排汽 -> VIOLATION 及最小前缀', () => {
  const h = [
    cmd('LOCK_DOOR'),
    ack('DOOR', 'LOCKED'),
    cmd('START_HEAT'),
    ack('PRESSURE', 'LOW'),
    cmd('OPEN_EXHAUST'),
    cmd('STOP_HEAT'),
  ];
  const v = verify(h);
  assert.equal(v.verdict, 'VIOLATION');
  assert.match(v.violationReason, /before pressure reached/);
  assert.deepEqual(v.minimalViolation, h.slice(0, 5));
  assert.equal(v.safeState.isSafe, false);
});

test('最小前缀性质: 更短前缀均不违例', () => {
  const h = [cmd('LOCK_DOOR'), cmd('START_HEAT'), ack('PRESSURE', 'LOW'), cmd('OPEN_EXHAUST')];
  const mv = minimalViolation(h);
  assert.equal(mv.length, 4);
  for (let i = 0; i < mv.length - 1; i++) {
    assert.notEqual(evaluate(mv.slice(0, i + 1)).verdict, 'VIOLATION');
  }
});

test('验收4: 未知 ack 保持 UNKNOWN, 不判安全', () => {
  const h = [cmd('LOCK_DOOR'), cmd('START_HEAT'), cmd('OPEN_EXHAUST')];
  const v = verify(h);
  assert.equal(v.verdict, 'UNKNOWN');
  assert.equal(v.safeState.isSafe, false);
  assert.equal(v.safeState.sensors.PRESSURE, 'UNKNOWN');
  assert.equal(v.minimalViolation, null);
});

test('开门联锁: 余压未泄开釜门 -> VIOLATION; 泄压后 -> SAFE', () => {
  const bad = [cmd('LOCK_DOOR'), cmd('START_HEAT'), ack('PRESSURE', 'LOW'), cmd('OPEN_DOOR')];
  assert.equal(evaluate(bad).verdict, 'VIOLATION');
  const good = [
    cmd('LOCK_DOOR'), cmd('START_HEAT'), ack('PRESSURE', 'OK'),
    cmd('STOP_HEAT'), ack('PRESSURE', 'ZERO'), cmd('OPEN_DOOR'),
  ];
  const r = evaluate(good);
  assert.equal(r.verdict, 'SAFE');
  assert.equal(r.safeState.phase, 'IDLE');
});

test('非法相迁移: IDLE 直接 START_HEAT -> VIOLATION', () => {
  const r = evaluate([cmd('START_HEAT')]);
  assert.equal(r.verdict, 'VIOLATION');
  assert.match(r.violationReason, /illegal in phase IDLE/);
});
