import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, baseRecipes, runWorld, readJsonl } from '../support/helpers.js';

test('A: inherited factory approval is truncated by a workshop deny', () => {
  const dir = tmpdir();
  const { res, out } = runWorld(dir,
    baseRecipes({ recipes: [{ id: 'R1', versions: [2] }] }),
    [
      { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 2 },
      { ts: 2, op: 'deny', id: 'd1', level: 'workshop', workshop: 'W1', recipe: 'R1', version: 2 },
    ],
    [
      { ts: 3, op: 'feed', reactor: 'K1', recipe: 'R1', version: 2 },
      { ts: 4, op: 'feed', reactor: 'K3', recipe: 'R1', version: 2 },
    ]);
  assert.equal(res.status, 0, res.stderr);
  const lines = readJsonl(out);
  assert.equal(lines.length, 2);
  // K1 sits in W1: the workshop deny truncates the inherited factory grant.
  assert.equal(lines[0].decision, 'deny');
  assert.equal(lines[0].reason, 'denied');
  assert.equal(lines[0].rule, 'd1');
  // K3 sits in W2: untouched by the deny, inheritance still allows.
  assert.equal(lines[1].decision, 'allow');
  assert.equal(lines[1].approval, 'a1');
  assert.deepEqual(lines[1].chain, ['a1']);
});

test('A2: most specific rule wins; a later same-level grant supersedes an earlier deny', () => {
  const dir = tmpdir();
  const { res, out } = runWorld(dir,
    baseRecipes({ recipes: [{ id: 'R1', versions: [2] }] }),
    [
      { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 2 },
      { ts: 2, op: 'deny', id: 'd1', level: 'workshop', workshop: 'W1', recipe: 'R1', version: 2 },
      { ts: 3, op: 'grant', id: 'a2', level: 'workshop', workshop: 'W1', recipe: 'R1', version: 2 },
      { ts: 4, op: 'grant', id: 'a3', level: 'reactor', reactor: 'K1', recipe: 'R1', version: 2 },
    ],
    [
      { ts: 5, op: 'feed', reactor: 'K1', recipe: 'R1', version: 2 },
      { ts: 6, op: 'feed', reactor: 'K2', recipe: 'R1', version: 2 },
    ]);
  assert.equal(res.status, 0, res.stderr);
  const lines = readJsonl(out);
  // K1: reactor-level grant a3 is the most specific rule.
  assert.equal(lines[0].decision, 'allow');
  assert.equal(lines[0].approval, 'a3');
  assert.deepEqual(lines[0].chain, ['a1', 'a2', 'a3']);
  // K2: workshop grant a2 (ts 3) supersedes the earlier workshop deny d1 (ts 2).
  assert.equal(lines[1].decision, 'allow');
  assert.equal(lines[1].approval, 'a2');
  assert.deepEqual(lines[1].chain, ['a1', 'a2']);
});

test('A3: proof directory contains per-reactor replay files', () => {
  const dir = tmpdir();
  const { res, proofdir } = runWorld(dir,
    baseRecipes({ recipes: [{ id: 'R1', versions: [2] }] }),
    [{ ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 2 }],
    [{ ts: 2, op: 'feed', reactor: 'K1', recipe: 'R1', version: 2 }]);
  assert.equal(res.status, 0, res.stderr);
  const proof = JSON.parse(fs.readFileSync(path.join(proofdir, 'K1.json'), 'utf8'));
  assert.equal(proof.reactor, 'K1');
  assert.equal(proof.workshop, 'W1');
  assert.equal(proof.verified, true);
  assert.equal(proof.replay.length, 1);
  assert.equal(proof.replay[0].decision, 'allow');
  assert.deepEqual(proof.finalContents, ['R1@2']);
  const summary = JSON.parse(fs.readFileSync(path.join(proofdir, 'summary.json'), 'utf8'));
  assert.equal(summary.allowed, 1);
  assert.equal(summary.denied, 0);
});
