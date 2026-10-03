import test from 'node:test';
import assert from 'node:assert/strict';
import { totalOrder } from '../src/order.js';
import { Engine } from '../src/engine.js';
import { mulberry32 } from './helpers.js';

// Acceptance 2: merging two forked histories must depend only on the
// deterministic total order, never on branch order inside the input.

function aliceOps() {
  return [
    { clock: 1, agentId: 'alice', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 2, agentId: 'alice', op: 'defineClaim', id: 'c1', type: 'all' },
    { clock: 3, agentId: 'alice', op: 'addEdge', claim: 'c1', ref: 'e1' },
    { clock: 5, agentId: 'alice', op: 'addEvidence', id: 'e1', weight: 7 },
  ];
}

function bobOps() {
  return [
    { clock: 1, agentId: 'bob', op: 'addEvidence', id: 'e2', weight: 3 },
    { clock: 2, agentId: 'bob', op: 'defineClaim', id: 'c2', type: 'quorum', threshold: 3 },
    { clock: 3, agentId: 'bob', op: 'addEdge', claim: 'c2', ref: 'e2' },
    { clock: 4, agentId: 'bob', op: 'addEdge', claim: 'c1', ref: 'c2' },
    { clock: 4, agentId: 'bob', op: 'addEvidence', id: 'e1', weight: 9 },
  ];
}

function replay(ops) {
  return new Engine().applyAll(totalOrder(ops)).stateHash();
}

test('total order sorts by (clock, agentId)', () => {
  const ordered = totalOrder([...bobOps(), ...aliceOps()]);
  assert.deepEqual(
    ordered.map((o) => [o.clock, o.agentId]),
    [
      [1, 'alice'],
      [1, 'bob'],
      [2, 'alice'],
      [2, 'bob'],
      [3, 'alice'],
      [3, 'bob'],
      [4, 'bob'],
      [4, 'bob'],
      [5, 'alice'],
    ]
  );
});

test('merged forks: branch order in input is irrelevant', () => {
  const ab = replay([...aliceOps(), ...bobOps()]);
  const ba = replay([...bobOps(), ...aliceOps()]);
  assert.equal(ab, ba);
});

test('merged forks: arbitrary interleaving of the same ops is irrelevant', () => {
  const base = replay([...aliceOps(), ...bobOps()]);
  const rand = mulberry32(42);
  for (let i = 0; i < 20; i++) {
    const shuffled = [...aliceOps(), ...bobOps()];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    assert.equal(replay(shuffled), base);
  }
});

test('conflicting weights: last in total order wins', () => {
  const engine = new Engine().applyAll(totalOrder([...aliceOps(), ...bobOps()]));
  const snap = engine.snapshot();
  // bob@4 (weight 9) is later than alice@5? No: alice@5 is last -> weight 7.
  const e1 = snap.evidence.find((e) => e.id === 'e1');
  assert.equal(e1.weight, 7);
});

test('conflicting weights: winner follows total order, not insertion order', () => {
  const late = { clock: 9, agentId: 'bob', op: 'addEvidence', id: 'e', weight: 1 };
  const early = { clock: 2, agentId: 'alice', op: 'addEvidence', id: 'e', weight: 5 };
  const a = new Engine().applyAll(totalOrder([late, early])).snapshot();
  const b = new Engine().applyAll(totalOrder([early, late])).snapshot();
  assert.equal(a.evidence[0].weight, 1);
  assert.equal(b.evidence[0].weight, 1);
});
