import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { verifyProof } from '../src/certs.js';

function chain() {
  const l = new Ledger();
  l.append({ type: 'add', id: 'A', parents: [], text: 'alpha batch', ts: 1 });
  l.append({ type: 'add', id: 'B', parents: ['A'], text: 'beta batch', ts: 2 });
  l.append({ type: 'add', id: 'C', parents: ['B'], text: 'gamma batch', ts: 3 });
  return l;
}

test('acceptance 3: deleted batch is masked in lineage queries but provable', () => {
  const l = chain();
  l.append({ type: 'delete', id: 'B', ts: 4 });

  // descendants of A: B masked out of live results, traversal continues to C
  const desc = l.descendants('A');
  assert.deepEqual(desc.live, ['C']);
  assert.deepEqual(desc.masked, ['B']);

  // ancestors of C: B masked, A still reachable through it
  const anc = l.ancestors('C');
  assert.deepEqual(anc.live, ['A']);
  assert.deepEqual(anc.masked, ['B']);

  // pre-deletion slice is untouched
  assert.deepEqual(l.ancestors('C', 3).live.sort(), ['A', 'B']);
  assert.deepEqual(l.ancestors('C', 3).masked, []);

  // search masks the tombstoned batch too
  assert.deepEqual(l.searchPhrase('beta').masked, ['B']);
  assert.deepEqual(l.searchPhrase('beta').live, []);

  // certificate proves the deletion: latest cert carries the tombstone bit
  const cert = l.cert('B');
  assert.equal(cert.tombstone, 1);
  const proof = l.prove('B');
  assert.equal(proof.cert.tombstone, 1);
  assert.ok(verifyProof(proof));
  assert.equal(proof.root, l.root());

  // earlier (pre-delete) cert version is still provable with tombstone 0
  const oldProof = l.prove('B', 0);
  assert.equal(oldProof.cert.tombstone, 0);
  assert.ok(verifyProof(oldProof));

  // tampered proof must fail
  const bad = structuredClone(proof);
  bad.leaf = bad.leaf.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.equal(verifyProof(bad), false);
});
