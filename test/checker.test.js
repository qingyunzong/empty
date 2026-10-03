import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVersion } from '../src/checker.js';
import { compile, ev, REGISTER_DSL, COMMUTE_RULE } from '../testkit/helpers.js';

const RULES = REGISTER_DSL + COMMUTE_RULE;

test('acceptance 1: concurrent commutative writes are linearizable', () => {
  const compiled = compile(RULES);
  const events = [
    ev('w1', { op: 'write', key: 'x', value: 1, invocation: 1, response: 5 }),
    ev('w2', { op: 'write', key: 'x', value: 2, invocation: 2, response: 6 }),
    ev('r', { op: 'read', key: 'x', value: 1, invocation: 7, response: 8 }),
  ];
  const res = checkVersion(events, compiled);
  assert.equal(res.verdict, 'LINEARIZABLE');
  // The witness must respect real-time order (both writes before the read).
  assert.ok(res.serialization.indexOf('w1') < res.serialization.indexOf('r'));
  assert.ok(res.serialization.indexOf('w2') < res.serialization.indexOf('r'));
});

test('commutation closure can reorder sequential writes to justify a stale read', () => {
  const events = [
    ev('w1', { op: 'write', key: 'x', value: 1, invocation: 1, response: 2 }),
    ev('w2', { op: 'write', key: 'x', value: 2, invocation: 3, response: 4 }),
    ev('r', { op: 'read', key: 'x', value: 1, invocation: 5, response: 6 }),
  ];
  // Real-time forces w1, w2, r; the read observes the stale value 1.
  assert.equal(checkVersion(events, compile(REGISTER_DSL)).verdict, 'NON_LINEARIZABLE');
  // The commutes rule declares the writes order-independent, so swapping
  // them yields a valid witness.
  assert.equal(checkVersion(events, compile(RULES)).verdict, 'LINEARIZABLE');
});

test('acceptance 2: causal cycle is non-linearizable, never UNKNOWN', () => {
  const compiled = compile(RULES);
  // Causal order says e2 -> e1 (prev chain), real-time order says e1 -> e2.
  const events = [
    ev('e1', { prev: 'e2', invocation: 1, response: 2, value: 1 }),
    ev('e2', { invocation: 3, response: 4, value: 2 }),
  ];
  const res = checkVersion(events, compiled);
  assert.equal(res.verdict, 'NON_LINEARIZABLE');
  assert.deepEqual(res.counterexample, ['e1', 'e2']);
});

test('acceptance 3: missing response yields UNKNOWN', () => {
  const compiled = compile(RULES);
  const events = [
    ev('w', { op: 'write', key: 'x', value: 1, invocation: 1, response: 2 }),
    ev('r', { op: 'read', key: 'x', value: 1, invocation: 3, response: null }),
  ];
  const res = checkVersion(events, compiled);
  assert.equal(res.verdict, 'UNKNOWN');
  assert.deepEqual(res.pending, ['r']);
});

test('UNKNOWN only for missing events: dangling prev reference', () => {
  const compiled = compile(RULES);
  const events = [ev('e1', { prev: 'ghost', invocation: 1, response: 2 })];
  const res = checkVersion(events, compiled);
  assert.equal(res.verdict, 'UNKNOWN');
  assert.deepEqual(res.danglingPrev, ['e1']);
});

test('contradictions are NON_LINEARIZABLE, not UNKNOWN', () => {
  const compiled = compile(REGISTER_DSL);
  // read observes a value nobody wrote, after a completed write of another value.
  const events = [
    ev('w', { op: 'write', key: 'x', value: 2, invocation: 1, response: 2 }),
    ev('r', { op: 'read', key: 'x', value: 1, invocation: 3, response: 4 }),
  ];
  assert.equal(checkVersion(events, compiled).verdict, 'NON_LINEARIZABLE');
});

test('acceptance 6: tied shortest counterexamples resolve by event id order', () => {
  const compiled = compile(REGISTER_DSL);
  // Two independent size-1 counterexamples: reads of never-written keys.
  const events = [
    ev('r2', { op: 'read', key: 'y', value: 7, invocation: 3, response: 4 }),
    ev('r1', { op: 'read', key: 'x', value: 5, invocation: 1, response: 2 }),
  ];
  const res = checkVersion(events, compiled);
  assert.equal(res.verdict, 'NON_LINEARIZABLE');
  assert.deepEqual(res.counterexample, ['r1']);
});

test('acceptance 6: counterexample event ids are listed sorted', () => {
  const compiled = compile(REGISTER_DSL);
  // Causal cycle between w2 and r1; every proper subset is linearizable.
  const events = [
    ev('w2', { op: 'write', key: 'x', value: 2, invocation: 3, response: 4 }),
    ev('r1', { op: 'read', key: 'x', value: null, prev: 'w2', invocation: 1, response: 2 }),
  ];
  const res = checkVersion(events, compiled);
  assert.equal(res.verdict, 'NON_LINEARIZABLE');
  assert.deepEqual(res.counterexample, ['r1', 'w2']);
});

test('concurrent rule cancels the real-time edge', () => {
  const compiled = compile(REGISTER_DSL + `
rule c {
  concurrent write(k1, _), read(k2) when k1 == k2
}
`);
  const events = [
    ev('w', { op: 'write', key: 'x', value: 1, invocation: 1, response: 2 }),
    ev('r', { op: 'read', key: 'x', value: null, invocation: 3, response: 4 }),
  ];
  // Real-time alone would force w before r (read must see 1, sees null).
  assert.equal(checkVersion(events, compile(REGISTER_DSL)).verdict, 'NON_LINEARIZABLE');
  assert.equal(checkVersion(events, compiled).verdict, 'LINEARIZABLE');
});

test('happens-before rule adds an ordering edge', () => {
  const compiled = compile(REGISTER_DSL + `
rule hb {
  happens-before read(k), write(k, _) when a.value == b.value
}
`);
  const events = [
    ev('r', { op: 'read', key: 'x', value: 1, invocation: 1, response: 5 }),
    ev('w', { op: 'write', key: 'x', value: 1, invocation: 2, response: 6 }),
  ];
  // Without the rule, w then r is a valid serialization.
  assert.equal(checkVersion(events, compile(REGISTER_DSL)).verdict, 'LINEARIZABLE');
  // The rule forces r before w, and then r cannot observe 1.
  assert.equal(checkVersion(events, compiled).verdict, 'NON_LINEARIZABLE');
});

test('commutes rule with regex key pattern', () => {
  const compiled = compile(REGISTER_DSL + `
rule rc {
  commutes write(/user:.*/, _), write(/user:.*/, _)
}
`);
  const events = [
    ev('w1', { op: 'write', key: 'user:1', value: 1, invocation: 1, response: 5 }),
    ev('w2', { op: 'write', key: 'user:1', value: 2, invocation: 2, response: 6 }),
    ev('r', { op: 'read', key: 'user:1', value: 1, invocation: 7, response: 8 }),
  ];
  assert.equal(checkVersion(events, compiled).verdict, 'LINEARIZABLE');
});

test('read of initial value null is valid', () => {
  const compiled = compile(REGISTER_DSL);
  const events = [ev('r', { op: 'read', key: 'x', value: null, invocation: 1, response: 2 })];
  assert.equal(checkVersion(events, compiled).verdict, 'LINEARIZABLE');
});

test('empty history is linearizable', () => {
  const compiled = compile(REGISTER_DSL);
  assert.equal(checkVersion([], compiled).verdict, 'LINEARIZABLE');
});
