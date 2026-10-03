'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkLog, checkPrepared } = require('../src/check');
const { prepareFlow } = require('../src/flow');
const { simulate } = require('../src/automata');

// 验收 A: 合法流程通过且路径可重放
test('A: legal log accepted and witness path replays exactly', () => {
  const source = '(apply review release post)+ (reverse post?)?';
  const log = [
    'apply', 'review', 'release', 'post',
    'apply', 'review', 'release', 'post',
    'reverse', 'post',
  ];
  const prepared = prepareFlow(source);
  const result = checkPrepared(prepared, log);
  assert.equal(result.accept, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.witness.states.length, log.length + 1);
  // 独立重放: 从初态逐步模拟事件, 必须复现见证中的状态路径
  const replay = simulate(prepared.dfa, log);
  assert.equal(replay.accepted, true);
  assert.deepEqual(replay.states, result.witness.states);
});

test('A: chinese aliases canonicalize to the same events', () => {
  const result = checkLog('apply review release post', ['申请', '复核', '放行', '入账']);
  assert.equal(result.accept, true);
});

test('A: rejected log witness stops at the first failing event', () => {
  const result = checkLog('apply review release post', ['apply', 'release']);
  assert.equal(result.accept, false);
  assert.equal(result.witness.failIndex, 1);
  assert.equal(result.witness.event, 'release');
  assert.deepEqual(result.witness.states, [0, 1]);
});
