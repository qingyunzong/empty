import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, runWorld } from '../support/helpers.js';

const plant = {
  factories: [{ id: 'F1', workshops: [{ id: 'W1', kettles: ['K1'] }] }],
};

test('exit 16 on version rollback within a kettle', () => {
  const dir = makeWorld({
    recipes: { plant, versions: [{ id: 'v1', seq: 1 }, { id: 'v2', seq: 2 }], forbidden: [] },
    approvals: [{ id: 'a1', kind: 'grant', level: 'factory', target: 'F1', version: '*', ts: 1 }],
    attempts: [
      { id: 't1', kettle: 'K1', version: 'v2', operator: 'op1', ts: 2 },
      { id: 't2', kettle: 'K1', version: 'v1', operator: 'op1', ts: 3 },
    ],
  });
  const res = runWorld(dir);
  assert.equal(res.status, 16, res.stderr);
  assert.match(res.stderr, /version rollback/);
});

test('exit 17 on broken approval chain (dangling revoke)', () => {
  const dir = makeWorld({
    recipes: { plant, versions: [{ id: 'v1', seq: 1 }], forbidden: [] },
    approvals: [{ id: 'r1', kind: 'revoke', revokes: 'ghost', reason: 'x', ts: 1 }],
    attempts: [],
  });
  const res = runWorld(dir);
  assert.equal(res.status, 17, res.stderr);
  assert.match(res.stderr, /missing approval ghost/);
});

test('exit 17 on broken approval chain (parent not an ancestor)', () => {
  const dir = makeWorld({
    recipes: { plant, versions: [{ id: 'v1', seq: 1 }], forbidden: [] },
    approvals: [
      { id: 'a1', kind: 'grant', level: 'workshop', target: 'W1', version: 'v1', ts: 1 },
      { id: 'a2', kind: 'grant', level: 'kettle', target: 'K1', version: 'v1', ts: 1, parent: 'nope' },
    ],
    attempts: [],
  });
  const res = runWorld(dir);
  assert.equal(res.status, 17, res.stderr);
  assert.match(res.stderr, /parent nope not found/);
});

test('exit 18 on forbidden table cycle', () => {
  const dir = makeWorld({
    recipes: {
      plant,
      versions: [{ id: 'v1', seq: 1 }, { id: 'v2', seq: 2 }],
      forbiddenGroups: { g1: ['@g2'], g2: ['@g1'] },
      forbidden: [{ pair: ['@g1', 'v2'] }],
    },
    approvals: [],
    attempts: [],
  });
  const res = runWorld(dir);
  assert.equal(res.status, 18, res.stderr);
  assert.match(res.stderr, /forbidden table cycle/);
});
