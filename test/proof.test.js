'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFlow, judgeEvents, makeProof, verifyProof, Session } = require('../lib');
const { flowLinear, flowLoop, logFromRoles } = require('./helpers');

const okEvents = logFromRoles(['经办', '复核', '清算', '归档']);

function validProof() {
  const compiled = compileFlow(flowLinear);
  const judged = judgeEvents(compiled, okEvents);
  return makeProof(compiled, okEvents, judged);
}

test('valid proof verifies ok', () => {
  const r = verifyProof(flowLinear, okEvents, validProof());
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'accept');
});

test('reject verdict proof verifies ok', () => {
  const events = logFromRoles(['经办', '清算']);
  const compiled = compileFlow(flowLinear);
  const proof = makeProof(compiled, events, judgeEvents(compiled, events));
  const r = verifyProof(flowLinear, events, proof);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'reject');
});

test('E: tampering any single event id in proof fails verification', () => {
  const proof = validProof();
  for (let i = 0; i < proof.eventIds.length; i++) {
    const tampered = JSON.parse(JSON.stringify(proof));
    tampered.eventIds[i] = `forged-${i}`;
    const r = verifyProof(flowLinear, okEvents, tampered);
    assert.equal(r.ok, false, `tamper at index ${i} must fail`);
  }
});

test('tampering dfaHash fails', () => {
  const p = validProof();
  p.dfaHash = p.dfaHash.replace(/^./, p.dfaHash[0] === 'a' ? 'b' : 'a');
  const r = verifyProof(flowLinear, okEvents, p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DFA_HASH_MISMATCH');
});

test('tampering finalState fails', () => {
  const p = validProof();
  p.finalState = p.finalState === 0 ? 1 : 0;
  const r = verifyProof(flowLinear, okEvents, p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'FINAL_STATE_MISMATCH');
});

test('tampering verdict fails', () => {
  const p = validProof();
  p.verdict = 'reject';
  const r = verifyProof(flowLinear, okEvents, p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'VERDICT_MISMATCH');
});

test('proof against a different flow fails', () => {
  const r = verifyProof(flowLoop, okEvents, validProof());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DFA_HASH_MISMATCH');
});

test('verifier is independent of CLI/session caches', () => {
  // poison a session cache; verification must still succeed from scratch
  const s = new Session(flowLinear);
  for (const e of okEvents) s.append(e);
  s.judge();
  for (const k of s.cache.keys()) s.cache.set(k, 12345);
  const r = verifyProof(flowLinear, okEvents, validProof());
  assert.equal(r.ok, true);
});

test('dropping an event id from proof fails', () => {
  const p = validProof();
  p.eventIds.pop();
  const r = verifyProof(flowLinear, okEvents, p);
  assert.equal(r.ok, false);
});
