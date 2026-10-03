'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkLog } = require('../src/check');
const { FlowError } = require('../src/errors');

test('edge: empty log accepted only when the regex accepts empty', () => {
  assert.equal(checkLog('(apply review)?', []).accept, true);
  assert.equal(checkLog('apply review', []).accept, false);
});

test('edge: reversal cannot cancel an unposted entry', () => {
  const result = checkLog('apply post (reverse)?', ['apply', 'reverse']);
  assert.equal(result.accept, false);
  assert.ok(result.reasons.some((r) => r.code === 'REVERSAL_WITHOUT_POSTING' && r.index === 1));
});

test('edge: reversal after posting is fine', () => {
  const result = checkLog('apply post reverse', ['apply', 'post', 'reverse']);
  assert.equal(result.accept, true);
});

test('edge: unknown event rejected immediately', () => {
  const result = checkLog('apply review', ['apply', 'fly']);
  assert.equal(result.accept, false);
  assert.ok(result.reasons.some((r) => r.code === 'UNKNOWN_EVENT' && r.index === 1));
  assert.equal(result.witness.failIndex, 1);
});

test('edge: EMPTY_ALPHABET when the regex mentions no events', () => {
  assert.throws(() => checkLog('eps', []), (err) => err instanceof FlowError && err.code === 'EMPTY_ALPHABET');
});

test('edge: NONTERM_AUTOMATON when no accepting state is reachable', () => {
  assert.throws(() => checkLog('apply empty', ['apply']), (err) => err.code === 'NONTERM_AUTOMATON');
  assert.throws(() => checkLog('reverse', ['reverse']), (err) => err.code === 'NONTERM_AUTOMATON');
});

test('edge: LOG_TOO_LONG beyond 200 events', () => {
  const log = new Array(201).fill('apply');
  assert.throws(() => checkLog('apply*', log), (err) => err.code === 'LOG_TOO_LONG');
  assert.equal(checkLog('apply*', new Array(200).fill('apply')).accept, true);
});

test('edge: parse errors carry PARSE_ERROR code', () => {
  assert.throws(() => checkLog('apply (review', []), (err) => err.code === 'PARSE_ERROR');
  assert.throws(() => checkLog('apply fly', []), (err) => err.code === 'PARSE_ERROR');
  assert.throws(() => checkLog('', []), (err) => err.code === 'PARSE_ERROR');
});
