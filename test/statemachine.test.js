import test from 'node:test';
import assert from 'node:assert/strict';
import { Replica, STATES, compareClocks, reduceOrder } from '../src/statemachine.js';

// Independent reference table: expected outcome per causal relation of
// the cancel (C) and match (M) events, regardless of replica placement.
const REFERENCE = {
  'cancel-first': { applyError: 'already-canceled', state: STATES.CANCELED, certValid: true },
  'match-first': { applyError: 'already-matched', state: STATES.MATCHED, certValid: true },
  concurrent: { applyError: null, state: STATES.CONFLICT, certValid: false },
};

const RELATIONS = ['cancel-first', 'match-first', 'concurrent'];
const REPLICAS = ['A', 'B'];

function buildScenario({ cancelReplica, matchReplica, relation }) {
  const replicas = { A: new Replica('A'), B: new Replica('B') };
  const orderId = 'ord-1';
  replicas[cancelReplica].createOrder(orderId);
  if (matchReplica !== cancelReplica) replicas[matchReplica].createOrder(orderId);

  let applyError = null;
  if (relation === 'cancel-first') {
    replicas[cancelReplica].cancel(orderId);
    if (matchReplica !== cancelReplica) replicas[matchReplica].merge(replicas[cancelReplica]);
    try {
      replicas[matchReplica].match(orderId);
    } catch (err) {
      applyError = err.code;
    }
  } else if (relation === 'match-first') {
    replicas[matchReplica].match(orderId);
    if (cancelReplica !== matchReplica) replicas[cancelReplica].merge(replicas[matchReplica]);
    try {
      replicas[cancelReplica].cancel(orderId);
    } catch (err) {
      applyError = err.code;
    }
  } else {
    replicas[cancelReplica].cancel(orderId);
    replicas[matchReplica].match(orderId);
  }
  return { replicas, orderId, applyError };
}

test('exhaustive partial orders of cancel/match across two replicas match reference table', () => {
  for (const cancelReplica of REPLICAS) {
    for (const matchReplica of REPLICAS) {
      for (const relation of RELATIONS) {
        if (relation === 'concurrent' && cancelReplica === matchReplica) continue;
        const label = `cancel@${cancelReplica} match@${matchReplica} ${relation}`;
        const expected = REFERENCE[relation];
        const { replicas, orderId, applyError } = buildScenario({ cancelReplica, matchReplica, relation });

        assert.equal(applyError, expected.applyError, `${label}: apply error`);

        // Merge in both directions; final state must be identical (commutative).
        const mergedAB = new Replica('AB').merge(replicas.A).merge(replicas.B);
        const mergedBA = new Replica('BA').merge(replicas.B).merge(replicas.A);
        const viewAB = mergedAB.getOrder(orderId);
        const viewBA = mergedBA.getOrder(orderId);
        assert.equal(viewAB.state, expected.state, `${label}: merged state`);
        assert.equal(viewBA.state, expected.state, `${label}: merged state (reverse)`);
        assert.deepEqual(
          viewAB.events.map((e) => e.eventId),
          viewBA.events.map((e) => e.eventId),
          `${label}: event sets identical`,
        );

        const cert = mergedAB.certificate(orderId);
        assert.equal(cert.valid, expected.certValid, `${label}: cert validity`);

        if (relation === 'concurrent') {
          // Both events must be kept; never a coin flip.
          const types = viewAB.events.map((e) => e.type).sort();
          assert.deepEqual(types, ['cancel', 'match'], `${label}: both events kept`);
          assert.equal(compareClocks(viewAB.conflict.cancel.clock, viewAB.conflict.match.clock), null);
        } else {
          // Losing event was refused at apply time and never persisted.
          const types = viewAB.events.map((e) => e.type);
          const kept = relation === 'cancel-first' ? 'cancel' : 'match';
          assert.deepEqual(types, [kept], `${label}: losing event not persisted`);
        }
      }
    }
  }
});

test('conflict requires an observing resolution; cert becomes valid after legal resolve', () => {
  const a = new Replica('A');
  const b = new Replica('B');
  a.createOrder('o');
  b.createOrder('o');
  a.cancel('o');
  b.match('o');
  a.merge(b);

  assert.equal(a.getOrder('o').state, STATES.CONFLICT);
  assert.equal(a.certificate('o').valid, false);

  // A resolution issued without observing both events is not a legal adjudication.
  const blind = new Replica('C');
  blind.createOrder('o');
  blind.issue('o', 'resolve', { to: STATES.MATCHED, reason: 'blind' }, 'C-1');
  a.merge(blind);
  assert.equal(a.getOrder('o').state, STATES.CONFLICT, 'blind resolution must not settle');
  assert.equal(a.certificate('o').valid, false);

  // Legal resolution: issuer has observed the conflict (both events).
  const { view } = a.resolve('o', STATES.CANCELED, 'ops ticket 42');
  assert.equal(view.state, STATES.CANCELED);
  const cert = a.certificate('o');
  assert.equal(cert.valid, true);
  assert.equal(cert.resolution.to, STATES.CANCELED);
  assert.equal(cert.resolution.reason, 'ops ticket 42');
  assert.equal(cert.resolution.basis.cancelEventId, cert.conflict.cancelEventId);
  assert.equal(cert.resolution.basis.matchEventId, cert.conflict.matchEventId);
  assert.ok(cert.resolution.basis.cancelHash && cert.resolution.basis.matchHash);
});

test('resolve without conflict is rejected', () => {
  const a = new Replica('A');
  a.createOrder('o');
  assert.throws(() => a.resolve('o', STATES.CANCELED, 'x'), /no-conflict/);
  a.cancel('o');
  assert.throws(() => a.resolve('o', STATES.CANCELED, 'x'), /no-conflict/);
});

test('local sequential errors: already-canceled / already-matched', () => {
  const a = new Replica('A');
  a.createOrder('o1');
  a.cancel('o1');
  assert.throws(() => a.match('o1'), (err) => err.code === 'already-canceled');
  assert.throws(() => a.cancel('o1'), (err) => err.code === 'already-canceled');

  a.createOrder('o2');
  a.match('o2');
  assert.throws(() => a.cancel('o2'), (err) => err.code === 'already-matched');
  assert.throws(() => a.match('o2'), (err) => err.code === 'already-matched');
});

test('events carry prevHash chain and vector clocks', () => {
  const a = new Replica('A');
  a.createOrder('o');
  const first = a.cancel('o').event;
  assert.match(first.prevHash, /^0{64}$/);
  assert.deepEqual(first.clock, { A: 1 });
  const b = new Replica('B');
  b.createOrder('o');
  b.merge(a);
  const second = b.issue('o', 'resolve', { to: 'CANCELED', reason: '' }, 'B-9');
  assert.notEqual(second.prevHash, first.prevHash);
  assert.deepEqual(second.clock, { A: 1, B: 1 });
});

test('reduceOrder is deterministic for concurrent events regardless of input order', () => {
  const a = new Replica('A');
  const b = new Replica('B');
  a.createOrder('o');
  b.createOrder('o');
  const c = a.cancel('o').event;
  const m = b.match('o').event;
  const v1 = reduceOrder('o', [c, m]);
  const v2 = reduceOrder('o', [m, c]);
  assert.equal(v1.state, STATES.CONFLICT);
  assert.equal(v2.state, STATES.CONFLICT);
  assert.deepEqual(v1.events, v2.events);
});

test('rejected events are recorded when a causally-losing event enters via merge', () => {
  // Craft a log where both events exist and cancel causally precedes match.
  const a = new Replica('A');
  a.createOrder('o');
  const cancel = a.cancel('o').event;
  const late = new Replica('B');
  late.createOrder('o');
  late.merge(a);
  const match = late.issue('o', 'match', null, 'B-1'); // bypasses apply-time guard
  const view = reduceOrder('o', [cancel, match]);
  assert.equal(view.state, STATES.CANCELED);
  assert.deepEqual(view.rejected, [{ eventId: 'B-1', reason: 'already-canceled' }]);

  const b = new Replica('B');
  b.createOrder('o');
  const matchFirst = b.match('o').event;
  const late2 = new Replica('C');
  late2.createOrder('o');
  late2.merge(b);
  const cancelLate = late2.issue('o', 'cancel', null, 'C-1');
  const view2 = reduceOrder('o', [matchFirst, cancelLate]);
  assert.equal(view2.state, STATES.MATCHED);
  assert.deepEqual(view2.rejected, [{ eventId: 'C-1', reason: 'already-matched' }]);
});
