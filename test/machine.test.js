import test from 'node:test';
import assert from 'node:assert/strict';
import { step } from '../src/machine.js';

test('合法迁移链 create->assign->start->complete', () => {
  let s = null;
  for (const [cmd, expect] of [['create', 'created'], ['assign', 'assigned'], ['start', 'started'], ['complete', 'completed']]) {
    const r = step(s, cmd);
    assert.equal(r.ok, true, cmd);
    s = r.status;
    assert.equal(s, expect);
  }
});

test('显式禁止 complete 后 start', () => {
  const r = step('completed', 'start');
  assert.equal(r.ok, false);
  assert.match(r.reason, /illegal-transition/);
});

test('显式禁止 cancel 后 assign', () => {
  const r = step('cancelled', 'assign');
  assert.equal(r.ok, false);
  assert.match(r.reason, /illegal-transition/);
});

test('其他非法迁移一律拒绝', () => {
  for (const [from, cmd] of [
    [null, 'assign'], [null, 'start'], [null, 'complete'], [null, 'cancel'],
    ['created', 'start'], ['created', 'complete'],
    ['assigned', 'complete'], ['assigned', 'assign'],
    ['started', 'assign'], ['started', 'cancel'],
    ['completed', 'complete'], ['completed', 'cancel'],
    ['cancelled', 'start'], ['cancelled', 'complete'],
  ]) {
    assert.equal(step(from, cmd).ok, false, `${from} -> ${cmd}`);
  }
  assert.equal(step('created', 'create').ok, false);
});
