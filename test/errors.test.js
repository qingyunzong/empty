import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/scheduler.js';
import { ExitError, EXIT } from '../src/errors.js';
import { MAP, grant, task } from '../fixtures/helpers.mjs';

test('exit 22: clock references a missing parent event', () => {
  const t = task('T1', { parents: ['G-MISSING'] });
  assert.throws(() => schedule({ map: MAP, tasks: [t], grants: [] }), (error) => {
    assert.ok(error instanceof ExitError);
    assert.equal(error.code, EXIT.MISSING_PARENT);
    assert.match(error.message, /G-MISSING/);
    return true;
  });
});

test('exit 23: task target coordinate out of bounds', () => {
  const t = task('T1', { target: { x: 99, y: 0 } });
  assert.throws(() => schedule({ map: MAP, tasks: [t], grants: [] }), (error) => {
    assert.equal(error.code, EXIT.OUT_OF_BOUNDS);
    return true;
  });
});

test('exit 23: map shelf coordinate out of bounds', () => {
  const badMap = {
    bounds: { width: 4, height: 4 },
    zones: [
      {
        id: 'Z',
        kind: 'normal',
        aisles: [{ id: 'A', shelves: [{ id: 'S', x: 7, y: 1 }] }],
      },
    ],
  };
  assert.throws(() => schedule({ map: badMap, tasks: [], grants: [] }), (error) => {
    assert.equal(error.code, EXIT.OUT_OF_BOUNDS);
    return true;
  });
});

test('exit 24: rescue dual authorization by the same person', () => {
  const t = task('T1', {
    type: 'rescue',
    target: { shelf: 'S-R-1' },
    authorizers: ['alice', 'alice'],
  });
  assert.throws(() => schedule({ map: MAP, tasks: [t], grants: [] }), (error) => {
    assert.equal(error.code, EXIT.DUPLICATE_AUTHORIZER);
    return true;
  });
});

test('exit 24 fires even when a grant exists but is expired', () => {
  const grants = [grant('G1', { zone: 'Z-RESTRICTED', from: 0, to: 5 })];
  const t = task('T1', {
    type: 'rescue',
    target: { zone: 'Z-RESTRICTED' },
    time: 10,
    authorizers: ['bob', 'bob'],
    parents: ['G1'],
  });
  assert.throws(() => schedule({ map: MAP, tasks: [t], grants }), (error) => {
    assert.equal(error.code, EXIT.DUPLICATE_AUTHORIZER);
    return true;
  });
});
