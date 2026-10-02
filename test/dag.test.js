import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDag, parseBudget, ReadySet } from '../src/dag.js';
import { ReplanError } from '../src/errors.js';
import { lcg, randomDag } from './helpers.js';

test('E_CYCLE on a dependency cycle, message names the cycle', () => {
  const dag = { tasks: [
    { id: 'a', deps: ['c'] },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['b'] },
    { id: 'd', deps: [] },
  ] };
  assert.throws(() => parseDag(dag), (e) => {
    assert.ok(e instanceof ReplanError);
    assert.equal(e.code, 'E_CYCLE');
    for (const id of ['a', 'b', 'c']) assert.ok(e.message.includes(id));
    return true;
  });
});

test('E_CYCLE on a self loop', () => {
  assert.throws(
    () => parseDag({ tasks: [{ id: 'a', deps: ['a'] }] }),
    (e) => e.code === 'E_CYCLE',
  );
});

test('E_INPUT on unknown dep / duplicate id / bad failRate', () => {
  assert.throws(() => parseDag({ tasks: [{ id: 'a', deps: ['ghost'] }] }), (e) => e.code === 'E_INPUT');
  assert.throws(() => parseDag({ tasks: [{ id: 'a' }, { id: 'a' }] }), (e) => e.code === 'E_INPUT');
  assert.throws(() => parseDag({ tasks: [{ id: 'a', failRate: 1.5 }] }), (e) => e.code === 'E_INPUT');
});

test('parseBudget: null dimension is allowed, negative rejected', () => {
  assert.deepEqual(parseBudget({ cpu: 1 }), { cpu: 1, mem: null, wall: null });
  assert.throws(() => parseBudget({ cpu: -1 }), (e) => e.code === 'E_INPUT');
});

test('incremental ready set matches from-scratch recomputation at every step', () => {
  const rng = lcg(12345);
  for (let iter = 0; iter < 40; iter++) {
    const dagObj = randomDag(rng, 1 + Math.floor(rng() * 12), 0.3);
    const dag = parseDag(dagObj);
    const rs = new ReadySet(dag);
    const completed = new Set();
    const recompute = () => dag.ids
      .filter((id) => !completed.has(id) && dag.tasks.get(id).deps.every((d) => completed.has(d)))
      .sort();
    assert.deepEqual([...rs.ready], recompute());
    while (rs.size > 0) {
      const id = rs.next();
      assert.ok(!completed.has(id));
      completed.add(id);
      rs.complete(id);
      assert.deepEqual([...rs.ready], recompute());
    }
    assert.equal(completed.size, dag.ids.length);
  }
});

test('ready set scoped to a plan subset ignores outside dependencies', () => {
  const dag = parseDag({ tasks: [
    { id: 'a', deps: [] },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['b'] },
  ] });
  const rs = new ReadySet(dag, ['b', 'c']);
  assert.deepEqual(rs.next(), 'b'); // 'a' is outside the subset, so 'b' is ready
  rs.complete('b');
  assert.deepEqual(rs.next(), 'c');
});
