'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareFlows, enumerateDistinguisher } = require('../src/equiv');
const { compileFlow } = require('../src/flow');
const { CANONICAL_EVENTS } = require('../src/events');

test('equiv: equivalent specs reported equal with no witness', () => {
  const result = compareFlows('apply (review)? release', 'apply review release | apply release');
  assert.equal(result.equiv, true);
  assert.equal(result.witness, undefined);
});

// 验收 D: 不等价生成区分见证, 且可被独立枚举器复现 (长度<=7, 事件5种)
test('D: distinguishing witness reproduced by independent enumerator', () => {
  const result = compareFlows('apply (review)? release', 'apply release');
  assert.equal(result.equiv, false);
  assert.deepEqual(result.witness.events, ['apply', 'review', 'release']);
  assert.equal(result.witness.acceptedBy, 'left');
  assert.equal(result.enumerator.reproduced, true);
  assert.deepEqual(result.enumerator.witness.events, result.witness.events);
});

test('D: enumerator over all 5 events up to length 7 agrees with BFS witness', () => {
  const left = compileFlow('apply (review release | release review) post');
  const right = compileFlow('apply release review post | apply review release post');
  const alphabet = CANONICAL_EVENTS;
  const enumWitness = enumerateDistinguisher(left.dfa, right.dfa, alphabet, 7);
  const result = compareFlows(
    'apply (review release | release review) post',
    'apply release review post | apply review release post',
  );
  assert.equal(result.equiv, true);
  assert.equal(enumWitness, null);
});

test('D: enumerator finds the same first witness in length-lex order', () => {
  const left = compileFlow('post reverse');
  const right = compileFlow('post (reverse)? apply?');
  const alphabet = CANONICAL_EVENTS;
  const enumWitness = enumerateDistinguisher(left.dfa, right.dfa, alphabet, 7);
  assert.deepEqual(enumWitness.events, ['post']);
  assert.equal(enumWitness.acceptedBy, 'right');
});
