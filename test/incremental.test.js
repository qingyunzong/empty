import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { totalOrder } from '../src/order.js';
import { mulberry32, randInt } from './helpers.js';

// After every single op, the incrementally-maintained state must equal a
// full from-scratch replay of the same total-ordered history.

const EVIDENCE = ['e0', 'e1', 'e2', 'e3', 'e4'];
const CLAIMS = ['c0', 'c1', 'c2', 'c3', 'c4'];
const NODES = [...EVIDENCE, ...CLAIMS];

function randomOp(rand, clock) {
  const agentId = rand() < 0.5 ? 'alice' : 'bob';
  const kind = randInt(rand, 0, 5);
  switch (kind) {
    case 0:
      return { clock, agentId, op: 'addEvidence', id: EVIDENCE[randInt(rand, 0, 4)], weight: randInt(rand, 0, 5) };
    case 1:
      return { clock, agentId, op: 'retractEvidence', id: EVIDENCE[randInt(rand, 0, 4)] };
    case 2: {
      const type = ['all', 'any', 'quorum'][randInt(rand, 0, 2)];
      const op = { clock, agentId, op: 'defineClaim', id: CLAIMS[randInt(rand, 0, 4)], type };
      if (type === 'quorum') op.threshold = randInt(rand, 0, 4);
      if (rand() < 0.3) op.weight = randInt(rand, 1, 3);
      return op;
    }
    case 3:
    case 4:
      return {
        clock,
        agentId,
        op: 'addEdge',
        claim: CLAIMS[randInt(rand, 0, 4)],
        ref: NODES[randInt(rand, 0, NODES.length - 1)],
      };
    default:
      return {
        clock,
        agentId,
        op: 'removeEdge',
        claim: CLAIMS[randInt(rand, 0, 4)],
        ref: NODES[randInt(rand, 0, NODES.length - 1)],
      };
  }
}

test('incremental updates match full replay after every op (random histories)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rand = mulberry32(seed);
    const ops = Array.from({ length: 60 }, (_, i) => randomOp(rand, i + 1));
    const ordered = totalOrder(ops);
    const incremental = new Engine();
    for (let i = 0; i < ordered.length; i++) {
      incremental.apply(ordered[i]);
      const fresh = new Engine().applyAll(ordered.slice(0, i + 1));
      assert.deepEqual(
        incremental.snapshot().statuses,
        fresh.snapshot().statuses,
        `seed ${seed} diverged after op ${i}: ${JSON.stringify(ordered[i])}`
      );
      assert.equal(incremental.stateHash(), fresh.stateHash());
    }
  }
});

test('retraction propagates invalidation along a dependency chain', () => {
  const e = new Engine().applyAll([
    { clock: 1, agentId: 'a', op: 'addEvidence', id: 'e1', weight: 1 },
    { clock: 2, agentId: 'a', op: 'defineClaim', id: 'c1', type: 'all' },
    { clock: 3, agentId: 'a', op: 'addEdge', claim: 'c1', ref: 'e1' },
    { clock: 4, agentId: 'a', op: 'defineClaim', id: 'c2', type: 'all' },
    { clock: 5, agentId: 'a', op: 'addEdge', claim: 'c2', ref: 'c1' },
    { clock: 6, agentId: 'a', op: 'defineClaim', id: 'c3', type: 'any' },
    { clock: 7, agentId: 'a', op: 'addEdge', claim: 'c3', ref: 'c2' },
  ]);
  assert.equal(e.statusOf('c3').satisfied, true);
  e.apply({ clock: 8, agentId: 'b', op: 'retractEvidence', id: 'e1' });
  assert.equal(e.statusOf('c1').satisfied, false);
  assert.equal(e.statusOf('c2').satisfied, false);
  assert.equal(e.statusOf('c3').satisfied, false);
  e.apply({ clock: 9, agentId: 'b', op: 'addEvidence', id: 'e1', weight: 1 }); // restore
  assert.equal(e.statusOf('c3').satisfied, true);
});
