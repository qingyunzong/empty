import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { verifyProof } from '../src/certs.js';
import { E_CYCLE, E_TIME, E_PROOF } from '../src/errors.js';

function abc() {
  const l = new Ledger();
  l.append({ type: 'add', id: 'A', parents: [], text: 'a', ts: 1 });
  l.append({ type: 'add', id: 'B', parents: ['A'], text: 'b', ts: 2 });
  l.append({ type: 'add', id: 'C', parents: ['B'], text: 'c', ts: 3 });
  return l;
}

test('acceptance 4: cycle via correction reports E_CYCLE', () => {
  const l = abc();
  // C is a descendant of B: re-parenting B under C closes a cycle
  assert.throws(
    () => l.append({ type: 'correct', child: 'B', from: 'A', to: 'C', ts: 4 }),
    (e) => e.code === E_CYCLE,
  );
  // self-parenting
  assert.throws(
    () => l.append({ type: 'correct', child: 'B', from: 'A', to: 'B', ts: 4 }),
    (e) => e.code === E_CYCLE,
  );
  // failed appends leave the ledger untouched
  assert.equal(l.events.length, 3);
  assert.deepEqual(l.ancestors('C').live.sort(), ['A', 'B']);
});

test('acceptance 4: out-of-order time reports E_TIME', () => {
  const l = abc();
  assert.throws(
    () => l.append({ type: 'add', id: 'D', parents: [], text: 'd', ts: 2 }),
    (e) => e.code === E_TIME,
  );
  assert.throws(
    () => l.append({ type: 'delete', id: 'A', ts: 1 }),
    (e) => e.code === E_TIME,
  );
  // equal ts is allowed (same-slice ordering by append sequence)
  l.append({ type: 'add', id: 'D', parents: [], text: 'd', ts: 3 });
  assert.equal(l.events.length, 4);
});

test('acceptance 4: proof failures report E_PROOF', () => {
  const l = abc();
  const proof = l.prove('A');
  assert.ok(verifyProof(proof));
  // malformed proof
  assert.throws(() => verifyProof({ leaf: 1 }), (e) => e.code === E_PROOF);
  assert.throws(() => verifyProof(null), (e) => e.code === E_PROOF);
  // proof for a non-existent leaf index
  assert.throws(() => l.stateAt().certLog.prove(99), (e) => e.code === E_PROOF);
  // swapped sibling side must not verify
  const bad = structuredClone(proof);
  bad.path = bad.path.map((p) => ({ ...p, side: p.side === 'left' ? 'right' : 'left' }));
  if (bad.path.length > 0) assert.equal(verifyProof(bad), false);
});
