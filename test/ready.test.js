import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDag } from '../src/dag.js';
import { ReadySet } from '../src/ready.js';

const diamond = {
  tasks: [
    { id: 'a', deps: [] },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['a'] },
    { id: 'd', deps: ['b', 'c'] },
  ],
};

test('incremental ready set updates as tasks complete', () => {
  const tasks = parseDag(diamond);
  const rs = new ReadySet(tasks, ['a', 'b', 'c', 'd']);
  assert.deepEqual(rs.readyIds(), ['a']);
  rs.complete('a');
  assert.deepEqual(rs.readyIds(), ['b', 'c']);
  rs.complete('b');
  assert.deepEqual(rs.readyIds(), ['c']); // d still blocked by c
  rs.complete('c');
  assert.deepEqual(rs.readyIds(), ['d']);
  rs.complete('d');
  assert.equal(rs.size, 0);
});

test('ready set seeded with a done set (resume scenario)', () => {
  const tasks = parseDag(diamond);
  const rs = new ReadySet(tasks, ['a', 'b', 'c', 'd'], new Set(['a', 'b']));
  assert.deepEqual(rs.readyIds(), ['c']);
  rs.complete('c');
  assert.deepEqual(rs.readyIds(), ['d']);
});

test('drop permanently removes a task and blocks dependents', () => {
  const tasks = parseDag(diamond);
  const rs = new ReadySet(tasks, ['a', 'b', 'c', 'd']);
  rs.complete('a');
  rs.drop('b');
  assert.deepEqual(rs.readyIds(), ['c']);
  rs.complete('c');
  assert.equal(rs.peek(), undefined); // d never becomes ready
  assert.equal(rs.size, 1);
});
