import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, baseRecipes, runWorld, readJsonl } from '../support/helpers.js';

test('B: revocation after a feed keeps history and records a deviation', () => {
  const dir = tmpdir();
  const { res, out, proofdir } = runWorld(dir,
    baseRecipes(),
    [
      { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 },
      { ts: 3, op: 'revoke', target: 'a1', reason: 'material quality hold' },
    ],
    [
      { ts: 2, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 },
      { ts: 4, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 },
    ]);
  assert.equal(res.status, 0, res.stderr);
  const lines = readJsonl(out);
  // History is preserved: the pre-revocation allow is not erased.
  assert.equal(lines[0].decision, 'allow');
  assert.equal(lines[0].approval, 'a1');
  // After revocation the same feed is denied.
  assert.equal(lines[1].decision, 'deny');
  assert.equal(lines[1].reason, 'no-approval');

  const deviations = readJsonl(path.join(proofdir, 'deviations.jsonl'));
  assert.equal(deviations.length, 1);
  assert.equal(deviations[0].type, 'deviation');
  assert.equal(deviations[0].approval, 'a1');
  assert.equal(deviations[0].reason, 'material quality hold');
  assert.equal(deviations[0].feeds.length, 1);
  assert.equal(deviations[0].feeds[0].reactor, 'K1');

  // The per-reactor proof retains both the replay and the deviation.
  const proof = JSON.parse(fs.readFileSync(path.join(proofdir, 'K1.json'), 'utf8'));
  assert.equal(proof.deviations.length, 1);
  assert.equal(proof.replay[0].decision, 'allow');
  assert.equal(proof.replay[1].decision, 'deny');
});

test('B2: revoking a factory grant cascades down the chain', () => {
  const dir = tmpdir();
  const { res, out, proofdir } = runWorld(dir,
    baseRecipes(),
    [
      { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 },
      { ts: 2, op: 'grant', id: 'a2', level: 'workshop', workshop: 'W1', recipe: 'R1', version: 1 },
      { ts: 3, op: 'grant', id: 'a3', level: 'reactor', reactor: 'K1', recipe: 'R1', version: 1 },
      { ts: 5, op: 'revoke', target: 'a1', reason: 'chain audit failure' },
    ],
    [
      { ts: 4, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 },
      { ts: 6, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 },
    ]);
  assert.equal(res.status, 0, res.stderr);
  const lines = readJsonl(out);
  assert.equal(lines[0].decision, 'allow');
  assert.deepEqual(lines[0].chain, ['a1', 'a2', 'a3']);
  assert.equal(lines[1].decision, 'deny');
  assert.equal(lines[1].reason, 'no-approval');
  // Every rule in the chain gets its own deviation record.
  const deviations = readJsonl(path.join(proofdir, 'deviations.jsonl'));
  assert.deepEqual(deviations.map((d) => d.approval).sort(), ['a1', 'a2', 'a3']);
  assert.ok(deviations.every((d) => d.reason === 'chain audit failure'));
});
