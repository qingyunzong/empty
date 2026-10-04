'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { minimizePatterns, verifyMinimization } = require('../src/automata');

test('a* minimizes to 2 blocks with a verifiable certificate', () => {
  const { complete, certificate } = minimizePatterns(['a*']);
  assert.strictEqual(certificate.states, 3); // pre-minimization DFA states
  assert.strictEqual(certificate.blocks.length, 2);
  assert.strictEqual(certificate.distinguishing.length, 1);
  assert.deepStrictEqual(verifyMinimization(complete, certificate), { ok: true });
});

test('(0|1)*1 minimizes to 3 states (incl. dead state) with a valid certificate', () => {
  const { complete, certificate } = minimizePatterns(['(0|1)*1']);
  assert.strictEqual(certificate.blocks.length, 3);
  assert.deepStrictEqual(verifyMinimization(complete, certificate), { ok: true });
});

test('union of a rule set is minimized as one automaton', () => {
  const { complete, certificate } = minimizePatterns(['0*1*', 'a(b|c)*d']);
  assert.ok(certificate.blocks.length >= 2);
  assert.deepStrictEqual(verifyMinimization(complete, certificate), { ok: true });
});

test('certificate verification rejects tampering', () => {
  const { complete, certificate } = minimizePatterns(['a*b']);
  assert.strictEqual(verifyMinimization(complete, certificate).ok, true);

  // merge two blocks
  const merged = JSON.parse(JSON.stringify(certificate));
  merged.blocks = [[...merged.blocks.flat()]];
  assert.strictEqual(verifyMinimization(complete, merged).ok, false);

  // corrupt a quotient transition
  const badTrans = JSON.parse(JSON.stringify(certificate));
  badTrans.transitions[0][0] = (badTrans.transitions[0][0] + 1) % badTrans.blocks.length;
  assert.strictEqual(verifyMinimization(complete, badTrans).ok, false);

  // corrupt a distinguishing witness
  const badWitness = JSON.parse(JSON.stringify(certificate));
  badWitness.distinguishing[0].witness += 'a';
  assert.strictEqual(verifyMinimization(complete, badWitness).ok, false);

  // drop a distinguishing pair
  const dropped = JSON.parse(JSON.stringify(certificate));
  dropped.distinguishing.pop();
  assert.strictEqual(verifyMinimization(complete, dropped).ok, false);
});
