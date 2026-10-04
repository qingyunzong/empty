import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceOrder, NEW, CANCELED, MATCHED, CONFLICT } from '../src/machine.js';
import { hashEvent } from '../src/event.js';
import { mergeClocks } from '../src/clock.js';

const REPLICAS = ['R1', 'R2'];

function tick(replica, base = {}) {
  return { ...base, [replica]: (base[replica] || 0) + 1 };
}

let seq = 0;
function ev(replica, type, clock, payload = {}) {
  const event = {
    eventId: `t${seq++}`,
    type,
    orderId: 'O',
    replica,
    clock,
    prevHash: null,
    ...payload,
  };
  event.hash = hashEvent(event);
  return event;
}

// Independent reference model: a plain lookup table over the causal
// relation between the cancel and the match event. Deliberately shares
// no code with src/machine.js.
const REFERENCE = {
  none: NEW,
  'cancel-only': CANCELED,
  'match-only': MATCHED,
  'cancel<match': CANCELED, // match observed the cancel -> match void
  'match<cancel': MATCHED, // cancel observed the match -> cancel void
  concurrent: CONFLICT, // no causal order -> keep both, conflict
};

// Build a (cancel, match) event pair on two replicas for a given relation.
function buildPair(cancelReplica, matchReplica, relation) {
  if (relation === 'cancel<match') {
    const cancel = ev(cancelReplica, 'cancel', tick(cancelReplica));
    const match = ev(matchReplica, 'match', tick(matchReplica, cancel.clock));
    return [cancel, match];
  }
  if (relation === 'match<cancel') {
    const match = ev(matchReplica, 'match', tick(matchReplica));
    const cancel = ev(cancelReplica, 'cancel', tick(cancelReplica, match.clock));
    return [cancel, match];
  }
  // concurrent: neither clock knows about the other
  const cancel = ev(cancelReplica, 'cancel', tick(cancelReplica));
  const match = ev(matchReplica, 'match', tick(matchReplica));
  return [cancel, match];
}

test('exhaustive partial orders of cancel/match on two replicas match reference table', () => {
  const relations = ['cancel<match', 'match<cancel', 'concurrent'];
  for (const cancelReplica of REPLICAS) {
    for (const matchReplica of REPLICAS) {
      for (const relation of relations) {
        const [cancel, match] = buildPair(cancelReplica, matchReplica, relation);
        // feed the reducer in both arrival orders; result must not depend on it
        for (const events of [[cancel, match], [match, cancel]]) {
          const { state } = reduceOrder(events);
          assert.equal(
            state,
            REFERENCE[relation],
            `${relation} cancel@${cancelReplica} match@${matchReplica} order=${events[0].type},${events[1].type}`,
          );
        }
      }
    }
  }
});

test('degenerate event sets match reference table', () => {
  assert.equal(reduceOrder([]).state, REFERENCE['none']);
  assert.equal(reduceOrder([ev('R1', 'cancel', tick('R1'))]).state, REFERENCE['cancel-only']);
  assert.equal(reduceOrder([ev('R2', 'match', tick('R2'))]).state, REFERENCE['match-only']);
});

test('causally ordered loser event is void, conflict keeps both events', () => {
  const [cancel, match] = buildPair('R1', 'R2', 'cancel<match');
  const ordered = reduceOrder([cancel, match]);
  assert.equal(ordered.state, CANCELED);
  assert.deepEqual(ordered.voidEvents, [match.eventId]);
  assert.equal(ordered.conflict, null);

  const [c2, m2] = buildPair('R1', 'R2', 'concurrent');
  const concurrent = reduceOrder([c2, m2]);
  assert.equal(concurrent.state, CONFLICT);
  assert.equal(concurrent.conflict.cancel.eventId, c2.eventId);
  assert.equal(concurrent.conflict.match.eventId, m2.eventId);
  assert.deepEqual(concurrent.voidEvents, []);
});

test('resolution only valid when it causally observes both conflicting events', () => {
  for (const decision of [CANCELED, MATCHED]) {
    const [cancel, match] = buildPair('R1', 'R2', 'concurrent');
    const seenBoth = mergeClocks(cancel.clock, match.clock);
    const resolve = ev('R1', 'resolve', tick('R1', seenBoth), { decision });
    const r = reduceOrder([cancel, match, resolve]);
    assert.equal(r.state, decision);
    assert.equal(r.resolution.eventId, resolve.eventId);
  }
});

test('resolution that does not observe both events leaves conflict standing', () => {
  const [cancel, match] = buildPair('R1', 'R2', 'concurrent');
  // resolver only saw the cancel, not the concurrent match
  const blind = ev('R1', 'resolve', tick('R1', cancel.clock), { decision: CANCELED });
  const r = reduceOrder([cancel, match, blind]);
  assert.equal(r.state, CONFLICT);
  assert.equal(r.resolution, null);
});
