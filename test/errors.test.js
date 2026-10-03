import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexMap } from '../src/map.js';
import { schedule } from '../src/scheduler.js';
import { ExitError, EXIT } from '../src/errors.js';

function makeMap() {
  return indexMap({
    width: 50,
    height: 50,
    zones: [
      { id: 'Z-RES', kind: 'restricted', aisles: [{ id: 'A-1', shelves: [{ id: 'S-1', x: 5, y: 5 }] }] },
    ],
  });
}

function assertExitCode(fn, code) {
  assert.throws(fn, (err) => err instanceof ExitError && err.code === code);
}

test('exit 22: clock references missing parent event', () => {
  const map = makeMap();
  const grants = [
    { id: 'g1', op: 'grant', subject: '*', level: 'zone', zone: 'Z-RES', event: 'e1', lamport: 2, parents: ['ghost'], time: 0 },
  ];
  assertExitCode(() => schedule(map, grants, []), EXIT.MISSING_PARENT);
});

test('exit 22: lamport clock not greater than parent', () => {
  const map = makeMap();
  const grants = [
    { id: 'g1', op: 'grant', subject: '*', level: 'zone', zone: 'Z-RES', event: 'e1', lamport: 5, parents: [], time: 0 },
  ];
  const tasks = [
    { id: 'T1', target: { zone: 'Z-RES' }, dispatch: { event: 'e2', lamport: 3, parents: ['e1'], time: 1 } },
  ];
  assertExitCode(() => schedule(map, grants, tasks), EXIT.MISSING_PARENT);
});

test('exit 23: shelf coordinate out of bounds in map', () => {
  assertExitCode(
    () =>
      indexMap({
        width: 10,
        height: 10,
        zones: [{ id: 'Z', kind: 'normal', aisles: [{ id: 'A', shelves: [{ id: 'S', x: 99, y: 0 }] }] }],
      }),
    EXIT.OUT_OF_BOUNDS,
  );
});

test('exit 23: task target coordinate out of bounds', () => {
  const map = makeMap();
  const tasks = [
    { id: 'T1', target: { zone: 'Z-RES', x: 100, y: 5 }, dispatch: { event: 'e1', lamport: 1, parents: [], time: 1 } },
  ];
  assertExitCode(() => schedule(map, [], tasks), EXIT.OUT_OF_BOUNDS);
});

test('exit 24: dual authorization with the same person twice', () => {
  const map = makeMap();
  const tasks = [
    {
      id: 'T-rescue',
      kind: 'rescue',
      target: { zone: 'Z-RES', aisle: 'A-1' },
      dispatch: { event: 'e1', lamport: 1, parents: [], time: 1 },
      dualAuth: ['alice', 'alice'],
    },
  ];
  assert.throws(
    () => schedule(map, [], tasks),
    (err) => err instanceof ExitError && err.code === EXIT.SAME_AUTH && /distinct/.test(err.message),
  );
});

test('rescue without dual authorization is denied, not overridden', () => {
  const map = makeMap();
  const tasks = [
    {
      id: 'T-rescue',
      kind: 'rescue',
      target: { zone: 'Z-RES', aisle: 'A-1' },
      dispatch: { event: 'e1', lamport: 1, parents: [], time: 1 },
    },
  ];
  const { plan, deny } = schedule(map, [], tasks);
  assert.equal(plan.length, 0);
  assert.equal(deny.length, 1);
  assert.match(deny[0].reason, /rescue-dual-auth-missing/);
});
