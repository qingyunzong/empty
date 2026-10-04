import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commit } from '../src/commit.js';
import { tmpRepo, batch, assertOp } from './helpers.js';

test('E_ORPHAN: dependency on a batch that does not exist', () => {
  const { repo } = tmpRepo();
  assert.throws(
    () => commit(repo, batch('b1', 'p1', 1, [assertOp('k', 1)], { deps: ['ghost'] })),
    (e) => e.code === 'E_ORPHAN' && e.details.missing.includes('ghost'),
  );
});

test('E_BAD_PARENT: parent version does not exist', () => {
  const { repo } = tmpRepo();
  commit(repo, batch('b0', 'p0', 1, [assertOp('k', 0)]));
  assert.throws(
    () => commit(repo, batch('b1', 'p1', 1, [assertOp('k', 1)], { parent: 'nope' })),
    (e) => e.code === 'E_BAD_PARENT',
  );
});

test('E_BAD_PARENT: multiple heads and no explicit parent', () => {
  const { repo } = tmpRepo();
  const root = commit(repo, batch('b0', 'p0', 1, [assertOp('k', 0)]));
  commit(repo, batch('b1', 'p1', 1, [assertOp('a', 1)], { parent: root.version }));
  commit(repo, batch('b2', 'p2', 1, [assertOp('b', 2)], { parent: root.version }));
  assert.throws(
    () => commit(repo, batch('b3', 'p3', 1, [assertOp('c', 3)])),
    (e) => e.code === 'E_BAD_PARENT' && e.details.heads.length === 2,
  );
});

test('E_INVALID: malformed batch', () => {
  const { repo } = tmpRepo();
  assert.throws(() => commit(repo, { id: 'x', ops: [{ op: 'frobnicate', key: 'k' }] }), (e) => e.code === 'E_INVALID');
});
