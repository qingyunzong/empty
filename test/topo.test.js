import test from 'node:test';
import assert from 'node:assert/strict';
import { ev, rng, randomDag, assertLexMinTopo } from './helpers.js';
import { kahn, computeDerived } from '../src/derive.js';
import { mergeBranches } from '../src/merge.js';
import { checkCertificate } from '../src/checker.js';

const byId = (arr) => Object.fromEntries(arr.map((e) => [e.id, e]));

test('causal chain with backwards timestamps stays legal and ordered by causality', () => {
  // ts decreases along the causal direction; causality wins over timestamps.
  const events = byId([
    ev('c', 300),
    ev('b', 200, { dependsOn: ['c'] }),
    ev('a', 100, { dependsOn: ['b'] }),
  ]);
  const { order } = kahn(events);
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('timestamps only break ties between ready candidates', () => {
  const events = byId([ev('z', 5), ev('y', 1), ev('x', 3)]);
  assert.deepEqual(kahn(events).order, ['y', 'x', 'z']);
});

test('n<=7: deterministic Kahn equals lex-min over all topological orders', () => {
  const rand = rng(42);
  for (let n = 1; n <= 7; n += 1) {
    for (let trial = 0; trial < 25; trial += 1) {
      assertLexMinTopo(randomDag(n, rand));
    }
  }
});

function mergedState(base, local, remote) {
  const branches = { base: byId(base), local: byId(local), remote: byId(remote) };
  const { events, conflicts } = mergeBranches(branches.base, branches.local, branches.remote);
  const derived = computeDerived(events, branches);
  const certificate = { order: derived.order, rounds: derived.rounds, edges: derived.edges };
  return { branches, events, conflicts: [...conflicts.values()], certificate };
}

test('independent checker accepts a valid certificate', () => {
  const s = mergedState(
    [ev('a', 1), ev('b', 2, { dependsOn: ['a'] })],
    [ev('a', 1, { note: 'n' }), ev('b', 2, { dependsOn: ['a'] })],
    [ev('a', 1), ev('b', 3, { dependsOn: ['a'] }), ev('c', 0, { dependsOn: ['b'] })],
  );
  const res = checkCertificate({ ...s.branches, events: s.events, certificate: s.certificate, conflicts: s.conflicts });
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
});

test('checker rejects certificate missing an event', () => {
  const s = mergedState([ev('a', 1)], [ev('a', 1), ev('b', 2)], [ev('a', 1)]);
  const bad = { ...s.certificate, order: s.certificate.order.filter((id) => id !== 'b') };
  const res = checkCertificate({ ...s.branches, events: s.events, certificate: bad, conflicts: s.conflicts });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.startsWith('CERT_EVENTS_MISMATCH')));
});

test('checker rejects an order violating a dependency edge', () => {
  const s = mergedState([ev('a', 1)], [ev('a', 1)], [ev('a', 1), ev('b', 2, { dependsOn: ['a'] })]);
  const bad = { ...s.certificate, order: ['b', 'a'] };
  const res = checkCertificate({ ...s.branches, events: s.events, certificate: bad, conflicts: s.conflicts });
  assert.ok(res.errors.some((e) => e.startsWith('EDGE_ORDER')));
});

test('checker rejects a non-minimal candidate choice', () => {
  // y(ts=1) and x(ts=3) are both ready in round 1; choosing x is illegal.
  const s = mergedState([ev('x', 3), ev('y', 1)], [ev('x', 3), ev('y', 1)], [ev('x', 3), ev('y', 1)]);
  const bad = {
    ...s.certificate,
    order: ['x', 'y'],
    rounds: [
      { chosen: 'x', candidates: ['y', 'x'] },
      { chosen: 'y', candidates: ['y'] },
    ],
  };
  const res = checkCertificate({ ...s.branches, events: s.events, certificate: bad, conflicts: s.conflicts });
  assert.ok(res.errors.some((e) => e.startsWith('ROUND_CHOICE')));
});

test('checker verifies conflict provenance against an independent merge', () => {
  const s = mergedState(
    [ev('a', 1, { note: 'x' })],
    [ev('a', 1, { note: 'y' })],
    [ev('a', 1, { note: 'z' })],
  );
  assert.equal(s.conflicts.length, 1);
  const ok = checkCertificate({ ...s.branches, events: s.events, certificate: s.certificate, conflicts: s.conflicts });
  assert.equal(ok.ok, true);
  const tampered = checkCertificate({
    ...s.branches, events: s.events, certificate: s.certificate,
    conflicts: [{ ...s.conflicts[0], fields: { note: { base: 'x', local: 'y', remote: 'FORGED' } } }],
  });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.errors.some((e) => e.startsWith('CONFLICT_PROVENANCE')));
});
