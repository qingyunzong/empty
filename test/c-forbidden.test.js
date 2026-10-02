import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, baseRecipes, runWorld, readJsonl } from '../support/helpers.js';

const FORBIDDEN = [['R1@1', 'R2@1']];

test('C: forbidden combination in the same reactor beats a valid approval', () => {
  const dir = tmpdir();
  const { res, out } = runWorld(dir,
    baseRecipes({ forbidden: FORBIDDEN }),
    [
      { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 },
      { ts: 2, op: 'grant', id: 'a2', level: 'factory', recipe: 'R2', version: 1 },
    ],
    [
      { ts: 3, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 },
      { ts: 4, op: 'feed', reactor: 'K1', recipe: 'R2', version: 1 },
      { ts: 5, op: 'feed', reactor: 'K2', recipe: 'R2', version: 1 },
    ]);
  assert.equal(res.status, 0, res.stderr);
  const lines = readJsonl(out);
  assert.equal(lines[0].decision, 'allow');
  // Valid approval a2 exists, yet the constraint wins.
  assert.equal(lines[1].decision, 'deny');
  assert.equal(lines[1].reason, 'forbidden');
  assert.equal(lines[1].approval, 'a2');
  assert.deepEqual(lines[1].conflicts, ['R1@1']);
  // A different reactor is unaffected.
  assert.equal(lines[2].decision, 'allow');
});

test('C2: emptying the reactor clears the forbidden constraint', () => {
  const dir = tmpdir();
  const { res, out } = runWorld(dir,
    baseRecipes({ forbidden: FORBIDDEN }),
    [
      { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 },
      { ts: 2, op: 'grant', id: 'a2', level: 'factory', recipe: 'R2', version: 1 },
    ],
    [
      { ts: 3, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 },
      { ts: 4, op: 'empty', reactor: 'K1' },
      { ts: 5, op: 'feed', reactor: 'K1', recipe: 'R2', version: 1 },
    ]);
  assert.equal(res.status, 0, res.stderr);
  const lines = readJsonl(out);
  assert.equal(lines[0].decision, 'allow');
  assert.equal(lines[1].decision, 'allow');
});

test('C3: constraint is directional - reverse order is allowed', () => {
  const dir = tmpdir();
  const { res, out } = runWorld(dir,
    baseRecipes({ forbidden: FORBIDDEN }),
    [
      { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 },
      { ts: 2, op: 'grant', id: 'a2', level: 'factory', recipe: 'R2', version: 1 },
    ],
    [
      { ts: 3, op: 'feed', reactor: 'K1', recipe: 'R2', version: 1 },
      { ts: 4, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 },
    ]);
  assert.equal(res.status, 0, res.stderr);
  const lines = readJsonl(out);
  assert.equal(lines[0].decision, 'allow');
  assert.equal(lines[1].decision, 'allow');
});
