'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFlow, judgeEvents, validateLog, FlowError, MAX_LOG } = require('../lib');
const { flowLinear, flowLoop, logFromRoles } = require('./helpers');

test('accept: full compliant log yields shortest compliant path', () => {
  const c = compileFlow(flowLinear);
  const events = logFromRoles(['经办', '复核', '清算', '归档']);
  const r = judgeEvents(c, events);
  assert.equal(r.verdict, 'accept');
  assert.equal(r.consumed, 4);
  assert.deepEqual(r.path.roles, ['经办', '复核', '清算', '归档']);
  // shortest path is no longer than the accepting log
  assert.ok(r.path.roles.length <= events.length);
});

test('accept: shortest path for loop flow is minimal', () => {
  const c = compileFlow(flowLoop);
  const events = logFromRoles(['经办', '复核', '清算', '归档', '经办', '复核', '清算', '归档']);
  const r = judgeEvents(c, events);
  assert.equal(r.verdict, 'accept');
  assert.deepEqual(r.path.roles, ['经办', '复核', '清算', '归档']);
});

test('C: reject reports earliest failure prefix and all continuations', () => {
  const c = compileFlow(flowLinear);
  const events = logFromRoles(['经办', '清算', '归档']);
  const r = judgeEvents(c, events);
  assert.equal(r.verdict, 'reject');
  assert.equal(r.consumed, 1);
  assert.deepEqual(r.prefix.map((e) => e.id), ['g0']);
  assert.equal(r.failingEvent.role, '清算');
  assert.deepEqual(r.continuations, ['复核']);
});

test('reject: incomplete log (non-accept final state) lists continuations', () => {
  const c = compileFlow(flowLinear);
  const events = logFromRoles(['经办', '复核']);
  const r = judgeEvents(c, events);
  assert.equal(r.verdict, 'reject');
  assert.equal(r.consumed, 2);
  assert.equal(r.failingEvent, undefined);
  assert.deepEqual(r.continuations, ['清算']);
});

test('reject: first event failing gives empty prefix', () => {
  const c = compileFlow(flowLinear);
  const r = judgeEvents(c, logFromRoles(['归档']));
  assert.equal(r.verdict, 'reject');
  assert.equal(r.consumed, 0);
  assert.deepEqual(r.prefix, []);
  assert.deepEqual(r.continuations, ['经办']);
});

test('A: out-of-order timestamps rejected with TIME_REORDER', () => {
  const events = [
    { id: 'a', ts: 100, role: '经办' },
    { id: 'b', ts: 50, role: '复核' },
  ];
  assert.throws(() => validateLog(events), (e) => e.code === 'TIME_REORDER');
  assert.throws(() => judgeEvents(compileFlow(flowLinear), events), (e) => e.code === 'TIME_REORDER');
});

test('equal timestamps are allowed', () => {
  const events = [
    { id: 'a', ts: 100, role: '经办' },
    { id: 'b', ts: 100, role: '复核' },
  ];
  assert.doesNotThrow(() => validateLog(events));
});

test('duplicate event id rejected with ID_REUSE', () => {
  const events = [
    { id: 'a', ts: 1, role: '经办' },
    { id: 'a', ts: 2, role: '复核' },
  ];
  assert.throws(() => validateLog(events), (e) => e.code === 'ID_REUSE');
});

test('log size limit enforced', () => {
  const events = [];
  for (let i = 0; i < MAX_LOG + 1; i++) events.push({ id: `x${i}`, ts: i, role: '经办' });
  assert.throws(() => validateLog(events), (e) => e.code === 'LOG_LIMIT');
});

test('unknown role in log simply fails to consume', () => {
  const c = compileFlow(flowLinear);
  const r = judgeEvents(c, [{ id: 'a', ts: 1, role: '审计' }]);
  assert.equal(r.verdict, 'reject');
  assert.equal(r.consumed, 0);
});

test('empty log rejected when start is not accepting', () => {
  const c = compileFlow(flowLinear);
  const r = judgeEvents(c, []);
  assert.equal(r.verdict, 'reject');
  assert.deepEqual(r.continuations, ['经办']);
});
