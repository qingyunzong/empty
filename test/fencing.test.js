import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, UnknownMemberError } from '../src/store.js';

const membership = [
  { id: 'm1', member: 'alpha', epoch: 1, seq: 1, type: 'join', clock: { alpha: 1 } },
  { id: 'm2', member: 'alpha', epoch: 1, seq: 2, type: 'interlock', clock: { alpha: 2 } },
  { id: 'm3', member: 'alpha', epoch: 1, seq: 3, type: 'leave', clock: { alpha: 3 } },
  { id: 'm4', member: 'alpha', epoch: 2, seq: 4, type: 'join', clock: { alpha: 4 } },
];

test('after leave + rejoin, low-epoch writes are fenced, high-epoch writes apply', () => {
  const stale = { id: 'x1', member: 'alpha', epoch: 1, seq: 5, type: 'reset', clock: { alpha: 5 } };
  const fresh = { id: 'x2', member: 'alpha', epoch: 2, seq: 5, type: 'reset', clock: { alpha: 5 } };

  const withStale = replay([...membership, stale]);
  assert.equal(withStale.interlocked, true, 'stale epoch-1 reset must not apply');
  assert.deepEqual(withStale.rejected, [{ id: 'x1', reason: 'fenced' }]);
  assert.equal(withStale.valve, 'CLOSED');

  const withFresh = replay([...membership, fresh]);
  assert.equal(withFresh.interlocked, false, 'epoch-2 reset applies');
  assert.equal(withFresh.valve, 'OPEN');
  assert.deepEqual(withFresh.rejected, []);
});

test('writes from a member that left and never rejoined are fenced, old history kept', () => {
  const ghost = { id: 'x3', member: 'alpha', epoch: 1, seq: 4, type: 'reset', clock: { alpha: 4 } };
  const state = replay([membership[0], membership[1], membership[2], ghost]);
  assert.equal(state.interlocked, true);
  assert.deepEqual(state.rejected, [{ id: 'x3', reason: 'fenced' }]);
  assert.ok(state.applied.includes('m2'), 'pre-leave event stays in history');
});

test('unknown member new event raises UnknownMemberError (exit code 4)', () => {
  const alien = { id: 'x9', member: 'delta', epoch: 1, seq: 1, type: 'interlock', clock: { delta: 1 } };
  assert.throws(() => replay([...membership, alien]), (err) => {
    assert.ok(err instanceof UnknownMemberError);
    assert.equal(err.exitCode, 4);
    assert.equal(err.member, 'delta');
    return true;
  });
});
