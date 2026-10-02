import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/verify.js';

const cmd = (name) => ({ type: 'cmd', name });
const ack = (sensor, value) => ({ type: 'ack', sensor, value });

test('线性化: ack 无因果前导命令 -> VIOLATION(因果), 最小序列截至该 ack', () => {
  const h = [cmd('LOCK_DOOR'), ack('PRESSURE', 'OK')];
  const v = verify(h);
  assert.equal(v.verdict, 'VIOLATION');
  assert.match(v.violationReason, /no causal antecedent START_HEAT/);
  assert.deepEqual(v.minimalViolation, h);
});

test('线性化: ack 在其因果命令之后 -> 通过', () => {
  const h = [cmd('LOCK_DOOR'), ack('DOOR', 'LOCKED'), cmd('START_HEAT'), ack('PRESSURE', 'OK')];
  const v = verify(h);
  assert.equal(v.verdict, 'SAFE');
  assert.equal(v.minimalViolation, null);
});

test('未知传感器 ack -> VIOLATION', () => {
  const v = verify([cmd('LOCK_DOOR'), ack('HUMIDITY', 'OK')]);
  assert.equal(v.verdict, 'VIOLATION');
  assert.match(v.violationReason, /unknown sensor HUMIDITY/);
});

test('verdict 优先级: VIOLATION 覆盖 UNKNOWN', () => {
  const h = [
    cmd('LOCK_DOOR'), cmd('START_HEAT'),
    cmd('OPEN_EXHAUST'),          // UNKNOWN: PRESSURE 未知
    ack('PRESSURE', 'LOW'),
    cmd('OPEN_DOOR'),             // VIOLATION: 余压开门
  ];
  const v = verify(h);
  assert.equal(v.verdict, 'VIOLATION');
  assert.equal(v.minimalViolation.length, 5);
});
