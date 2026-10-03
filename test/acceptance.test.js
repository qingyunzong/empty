import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeWorld, runWorld, readJsonl, readJson } from '../support/helpers.js';

const plant = {
  factories: [
    { id: 'F1', workshops: [
      { id: 'W1', kettles: ['K1'] },
      { id: 'W2', kettles: ['K2'] },
    ] },
  ],
};

test('A: inherited factory approval is truncated by a workshop deny', () => {
  const dir = makeWorld({
    recipes: { plant, versions: [{ id: 'v1', seq: 1 }], forbidden: [] },
    approvals: [
      { id: 'a1', kind: 'grant', level: 'factory', target: 'F1', version: 'v1', ts: 1 },
      { id: 'a2', kind: 'deny', level: 'workshop', target: 'W1', version: 'v1', ts: 2 },
    ],
    attempts: [
      { id: 't1', kettle: 'K1', version: 'v1', operator: 'op1', ts: 3 },
      { id: 't2', kettle: 'K2', version: 'v1', operator: 'op1', ts: 3 },
    ],
  });
  const res = runWorld(dir);
  assert.equal(res.status, 0, res.stderr);
  const allow = readJsonl(path.join(dir, 'allow.jsonl'));
  assert.equal(allow[0].decision, 'deny');
  assert.match(allow[0].reason, /denied at workshop W1 by a2/);
  assert.equal(allow[1].decision, 'allow');
  assert.equal(allow[1].approval, 'a1');
});

test('B: revocation after a feed keeps history and records a deviation', () => {
  const dir = makeWorld({
    recipes: { plant, versions: [{ id: 'v1', seq: 1 }], forbidden: [] },
    approvals: [
      { id: 'a1', kind: 'grant', level: 'kettle', target: 'K1', version: 'v1', ts: 1 },
      { id: 'r1', kind: 'revoke', revokes: 'a1', reason: 'quality hold', ts: 3 },
    ],
    attempts: [
      { id: 't1', kettle: 'K1', version: 'v1', operator: 'op1', ts: 2 },
      { id: 't2', kettle: 'K1', version: 'v1', operator: 'op1', ts: 4 },
    ],
  });
  const res = runWorld(dir);
  assert.equal(res.status, 0, res.stderr);
  const allow = readJsonl(path.join(dir, 'allow.jsonl'));
  assert.equal(allow[0].decision, 'allow');
  assert.equal(allow[1].decision, 'deny');

  const deviations = readJson(path.join(dir, 'proof', 'deviations.json'));
  assert.deepEqual(deviations, [
    { approval: 'a1', revoke: 'r1', reason: 'quality hold', feeds: ['t1'] },
  ]);

  // Historical feed is retained in the replay proof, not erased.
  const proof = readJson(path.join(dir, 'proof', 'kettle-K1.json'));
  assert.equal(proof.feeds.length, 1);
  assert.equal(proof.feeds[0].attempt, 't1');
  assert.equal(proof.feeds[0].approval, 'a1');
});

test('C: forbidden same-kettle pair beats a valid grant (constraint wins)', () => {
  const dir = makeWorld({
    recipes: {
      plant,
      versions: [{ id: 'v1', seq: 1 }, { id: 'v2', seq: 2 }],
      forbidden: [{ pair: ['v1', 'v2'] }],
    },
    approvals: [
      { id: 'a1', kind: 'grant', level: 'factory', target: 'F1', version: '*', ts: 1 },
    ],
    attempts: [
      { id: 't1', kettle: 'K1', version: 'v1', operator: 'op1', ts: 2 },
      { id: 't2', kettle: 'K1', version: 'v2', operator: 'op1', ts: 3 },
    ],
  });
  const res = runWorld(dir);
  assert.equal(res.status, 0, res.stderr);
  const allow = readJsonl(path.join(dir, 'allow.jsonl'));
  assert.equal(allow[0].decision, 'allow');
  assert.equal(allow[1].decision, 'deny');
  assert.equal(allow[1].conflictWith, 'v1');
  assert.match(allow[1].reason, /forbidden combination v1 \+ v2/);

  // Counterexample: minimal approval set that would (wrongly) allow t2.
  const cex = readJson(path.join(dir, 'proof', 'counterexample.json'));
  assert.equal(cex.length, 1);
  assert.equal(cex[0].attempt, 't2');
  assert.deepEqual(cex[0].minimalAllowSet, { size: 1, set: ['a1'] });
});
