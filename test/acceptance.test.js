import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/index.js';

const RULES = `rule Register {
  op write(key: string, value: int) -> string;
  op read(key: string) -> int;
  commutes(a, b): a.op == op"write" and b.op == op"write" and a.key == b.key;
  concurrent(a, b): a.key != b.key;
}`;

const NO_COMMUTES = `rule Register {
  op write(key: string, value: int) -> string;
  op read(key: string) -> int;
}`;

const ev = (over) => JSON.stringify({
  invocation: 'e?', response: 'r?', node: 'n1', prev: null,
  realTime: [0, 1], op: 'write', key: 'x', value: 1, ...over,
});

test('acceptance 1: concurrent commuting writes are linearizable', () => {
  // Two writes ordered by real time but declared commuting, plus a read
  // that observes the "older" write: only linearizable because the
  // commutes rule drops the real-time edge between the writes.
  const history = [
    ev({ invocation: 'w1', response: 'p1', realTime: [0, 10], op: 'write', value: 1 }),
    ev({ invocation: 'w2', response: 'p2', realTime: [11, 12], op: 'write', value: 2, node: 'n2' }),
    ev({ invocation: 'rd', response: 'p3', realTime: [13, 14], op: 'read', value: 1 }),
  ].join('\n');
  const withCommutes = check(RULES, history);
  assert.equal(withCommutes.verdict, 'LINEARIZABLE');
  assert.deepEqual(withCommutes.versions[0].certificate.order, ['w2', 'w1', 'rd']);

  // Same history without the commutes rule is not linearizable.
  const without = check(NO_COMMUTES, history);
  assert.equal(without.verdict, 'NON_LINEARIZABLE');
});

test('acceptance 2: causal cycle is non-linearizable (never UNKNOWN)', () => {
  const history = [
    ev({ invocation: 'e1', response: 'p1', prev: 'e2', realTime: [0, 1] }),
    ev({ invocation: 'e2', response: 'p2', prev: 'e1', realTime: [2, 3], node: 'n2' }),
  ].join('\n');
  const r = check(RULES, history);
  assert.equal(r.verdict, 'NON_LINEARIZABLE');
  assert.equal(r.versions[0].certificate.kind, 'cycle');
  assert.deepEqual(r.versions[0].certificate.operations, ['e1', 'e2']);
});

test('acceptance 3: missing response yields UNKNOWN', () => {
  const history = [
    ev({ invocation: 'e1', response: 'p1', realTime: [0, 1] }),
    JSON.stringify({ invocation: 'e2', node: 'n2', prev: null, realTime: [2], op: 'read', key: 'x', value: 1 }),
  ].join('\n');
  const r = check(RULES, history);
  assert.equal(r.verdict, 'UNKNOWN');
  assert.equal(r.versions[0].certificate.kind, 'missing');
  assert.deepEqual(r.versions[0].certificate.missing, [{ event: 'e2', reason: 'missing response event' }]);
});

test('acceptance 4: correction changes verdict, old certificate SUPERSEDED', () => {
  const history = [
    ev({ invocation: 'e1', response: 'p1', realTime: [0, 1], op: 'write', value: 1 }),
    ev({ invocation: 'e2', response: 'p2', realTime: [2, 3], op: 'read', value: 2, node: 'n2' }),
    JSON.stringify({ op: 'correct', corrects: 'e2', replacement: { op: 'read', key: 'x', value: 1, node: 'n2', realTime: [2, 3], response: 'p2' } }),
  ].join('\n');
  const r = check(RULES, history);
  assert.equal(r.versions.length, 2);
  assert.equal(r.versions[0].verdict, 'NON_LINEARIZABLE');
  assert.equal(r.versions[0].status, 'SUPERSEDED');
  assert.equal(r.versions[0].certificate.kind, 'counterexample');
  assert.equal(r.versions[1].verdict, 'LINEARIZABLE');
  assert.equal(r.versions[1].status, 'CURRENT');
  assert.equal(r.verdict, 'LINEARIZABLE');
});

test('acceptance 6: tied shortest counterexamples are ordered by event id', () => {
  // Two independent minimal non-linearizable cores of equal size.
  // Core B (ids b1,b2) appears first in the file; core A (ids a1,a2) wins
  // because the tie is broken by ascending event ids.
  const history = [
    ev({ invocation: 'b1', response: 'q1', realTime: [0, 1], op: 'write', key: 'x', value: 1 }),
    ev({ invocation: 'b2', response: 'q2', realTime: [2, 3], op: 'read', key: 'x', value: null }),
    ev({ invocation: 'a1', response: 'p1', realTime: [4, 5], op: 'write', key: 'y', value: 1 }),
    ev({ invocation: 'a2', response: 'p2', realTime: [6, 7], op: 'read', key: 'y', value: null }),
  ].join('\n');
  const r = check(NO_COMMUTES, history);
  assert.equal(r.verdict, 'NON_LINEARIZABLE');
  const cert = r.versions[0].certificate;
  assert.equal(cert.kind, 'counterexample');
  assert.deepEqual(cert.operations, ['a1', 'a2']);
});
