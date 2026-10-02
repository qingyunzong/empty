'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { loadHistory, replay } = require('../src/history');
const { snapshot } = require('../src/core');

// Two forked operator histories with interleaved Lamport clocks,
// conflicting weights, a concurrent retract, and edge changes.
const alice = [
  { clock: 1, agentId: 'alice', op: 'addEvidence', id: 'e1', weight: 2 },
  { clock: 2, agentId: 'alice', op: 'addEvidence', id: 'e2', weight: 3 },
  { clock: 4, agentId: 'alice', op: 'addClaim', id: 'c1', type: 'quorum', threshold: 4 },
  { clock: 5, agentId: 'alice', op: 'addEdge', claim: 'c1', ref: 'e1' },
  { clock: 7, agentId: 'alice', op: 'setWeight', id: 'e1', weight: 5 },
  { clock: 9, agentId: 'alice', op: 'retract', id: 'e2' },
  { clock: 11, agentId: 'alice', op: 'addClaim', id: 'c2', type: 'all' },
  { clock: 12, agentId: 'alice', op: 'addEdge', claim: 'c2', ref: 'c1' },
];
const bob = [
  { clock: 1, agentId: 'bob', op: 'addEvidence', id: 'e1', weight: 8 },
  { clock: 3, agentId: 'bob', op: 'addEdge', claim: 'c1', ref: 'e2' },
  { clock: 6, agentId: 'bob', op: 'addEdge', claim: 'c1', ref: 'e1' }, // duplicate of alice@5
  { clock: 8, agentId: 'bob', op: 'retract', id: 'e2' }, // concurrent retract with alice@9
  { clock: 10, agentId: 'bob', op: 'addEdge', claim: 'c2', ref: 'e1' },
];

test('merged result depends only on total order, not branch order in file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-'));
  const f1 = join(dir, 'ab.json');
  const f2 = join(dir, 'ba.json');
  writeFileSync(f1, JSON.stringify({ branches: { alice, bob } }));
  writeFileSync(f2, JSON.stringify({ branches: { bob, alice } })); // swapped key order

  const s1 = snapshot(replay(loadHistory(f1)));
  const s2 = snapshot(replay(loadHistory(f2)));
  assert.deepEqual(s2, s1);
  assert.equal(s1.stateHash, s2.stateHash);

  // last-writer: alice@7 (weight 5) is after bob@1 (weight 8)
  assert.equal(s1.evidence.e1.weight, 5);
  // e2 retracted by both; c1 quorum: only e1(5) active -> 5 >= 4 satisfied
  assert.equal(s1.evidence.e2.active, false);
  assert.equal(s1.claims.c1.state, 'satisfied');
  // bob@3 referenced c1 before alice@4 created it, and bob@10 referenced c2
  // before alice@11 created it: both are recorded as E_REF op errors.
  // bob@6 duplicates alice@5 and collapses, leaving a single edge.
  assert.deepEqual(s1.claims.c1.refs, ['e1']);
  assert.equal(s1.opErrors.length, 2);
  assert.ok(s1.opErrors.every((e) => e.error === 'E_REF'));
});

test('file order on the command line does not change the outcome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-'));
  const fa = join(dir, 'a.json');
  const fb = join(dir, 'b.json');
  writeFileSync(fa, JSON.stringify(alice));
  writeFileSync(fb, JSON.stringify(bob));

  const s1 = snapshot(replay([...loadHistory(fa), ...loadHistory(fb)]));
  const s2 = snapshot(replay([...loadHistory(fb), ...loadHistory(fa)]));
  assert.deepEqual(s2, s1);
});

test('branch arrays (anonymous) also merge deterministically', () => {
  const doc = { branches: [alice, bob] };
  const docSwapped = { branches: [bob, alice] };
  const dir = mkdtempSync(join(tmpdir(), 'hist-'));
  const f1 = join(dir, 'x.json');
  const f2 = join(dir, 'y.json');
  writeFileSync(f1, JSON.stringify(doc));
  writeFileSync(f2, JSON.stringify(docSwapped));
  assert.equal(
    snapshot(replay(loadHistory(f1))).stateHash,
    snapshot(replay(loadHistory(f2))).stateHash,
  );
});
