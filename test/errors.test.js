import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, baseRecipes, runWorld, writeJson, writeJsonl } from '../support/helpers.js';
import { ExitError, loadRecipes, loadJsonl, mergeEvents } from '../src/model.js';
import { Interpreter } from '../src/interpreter.js';

// NOTE: the sandboxed runner cannot capture child stdio, so exit codes are
// asserted through the CLI and error messages through direct library calls.

test('exit 16: version rollback inside recipes.json', () => {
  const dir = tmpdir();
  const recipes = baseRecipes({ recipes: [{ id: 'R1', versions: [2, 1] }] });
  const { res } = runWorld(dir, recipes, [], []);
  assert.equal(res.status, 16);
  const p = writeJson(dir, 'bad-recipes.json', recipes);
  assert.throws(() => loadRecipes(p), (e) => e instanceof ExitError && e.code === 16 && /rollback/i.test(e.message));
});

test('exit 16: feed attempt below the current recipe version', () => {
  const dir = tmpdir();
  const recipes = baseRecipes({ recipes: [{ id: 'R1', versions: [1, 2] }] });
  const approvals = [{ ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 }];
  const attempts = [{ ts: 2, op: 'feed', reactor: 'K1', recipe: 'R1', version: 1 }];
  const { res } = runWorld(dir, recipes, approvals, attempts);
  assert.equal(res.status, 16);
  const model = loadRecipes(writeJson(dir, 'recipes2.json', recipes));
  assert.throws(
    () => new Interpreter(model).run(mergeEvents(approvals, attempts)),
    (e) => e instanceof ExitError && e.code === 16 && /rollback/i.test(e.message));
});

test('exit 17: workshop grant without an active factory parent', () => {
  const dir = tmpdir();
  const approvals = [{ ts: 1, op: 'grant', id: 'a1', level: 'workshop', workshop: 'W1', recipe: 'R1', version: 1 }];
  const { res } = runWorld(dir, baseRecipes(), approvals, []);
  assert.equal(res.status, 17);
  const model = loadRecipes(writeJson(dir, 'recipes.json', baseRecipes()));
  assert.throws(
    () => new Interpreter(model).run(approvals),
    (e) => e instanceof ExitError && e.code === 17 && /chain broken/i.test(e.message));
});

test('exit 17: reactor grant without an active workshop parent', () => {
  const dir = tmpdir();
  const approvals = [
    { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 },
    { ts: 2, op: 'grant', id: 'a2', level: 'reactor', reactor: 'K1', recipe: 'R1', version: 1 },
  ];
  const { res } = runWorld(dir, baseRecipes(), approvals, []);
  assert.equal(res.status, 17);
  const model = loadRecipes(writeJson(dir, 'recipes.json', baseRecipes()));
  assert.throws(
    () => new Interpreter(model).run(approvals),
    (e) => e instanceof ExitError && e.code === 17 && /chain broken/i.test(e.message));
});

test('exit 17: revoke of an unknown approval', () => {
  const dir = tmpdir();
  const approvals = [{ ts: 1, op: 'revoke', target: 'nope', reason: 'x' }];
  const { res } = runWorld(dir, baseRecipes(), approvals, []);
  assert.equal(res.status, 17);
  const model = loadRecipes(writeJson(dir, 'recipes.json', baseRecipes()));
  assert.throws(
    () => new Interpreter(model).run(approvals),
    (e) => e instanceof ExitError && e.code === 17 && /chain broken/i.test(e.message));
});

test('exit 17: grant after its parent was revoked breaks the chain', () => {
  const dir = tmpdir();
  const approvals = [
    { ts: 1, op: 'grant', id: 'a1', level: 'factory', recipe: 'R1', version: 1 },
    { ts: 2, op: 'revoke', target: 'a1', reason: 'x' },
    { ts: 3, op: 'grant', id: 'a2', level: 'workshop', workshop: 'W1', recipe: 'R1', version: 1 },
  ];
  const { res } = runWorld(dir, baseRecipes(), approvals, []);
  assert.equal(res.status, 17);
});

test('exit 18: forbidden table cycle', () => {
  const dir = tmpdir();
  const recipes = baseRecipes({ forbidden: [['R1@1', 'R2@1'], ['R2@1', 'R1@1']] });
  const { res } = runWorld(dir, recipes, [], []);
  assert.equal(res.status, 18);
  const p = writeJson(dir, 'recipes.json', recipes);
  assert.throws(() => loadRecipes(p), (e) => e instanceof ExitError && e.code === 18 && /cycle/i.test(e.message));
});

test('exit 18: longer forbidden table cycle', () => {
  const dir = tmpdir();
  const recipes = baseRecipes({
    recipes: [{ id: 'R1', versions: [1] }, { id: 'R2', versions: [1] }, { id: 'R3', versions: [1] }],
    forbidden: [['R1@1', 'R2@1'], ['R2@1', 'R3@1'], ['R3@1', 'R1@1']],
  });
  const { res } = runWorld(dir, recipes, [], []);
  assert.equal(res.status, 18);
});

test('library: loadJsonl rejects lines without numeric ts', () => {
  const dir = tmpdir();
  const p = writeJsonl(dir, 'bad.jsonl', [{ op: 'feed' }]);
  assert.throws(() => loadJsonl(p), (e) => e instanceof ExitError && /ts/.test(e.message));
});
