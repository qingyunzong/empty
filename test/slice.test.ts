import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Event, State, validateTrace } from '../src/model';
import { dynamicSlice } from '../src/slice';
import { replay, valueAt } from '../src/replay';
import { verifySliceReplay, checkMinimality } from '../src/verify';

const konst = (id: number, v: string): Event => ({
  id, kind: 'assign', reads: [], writes: [v], controlDeps: [],
  apply: () => ({ [v]: `e${id}()` }),
});

const use = (id: number, reads: string[], write: string, controlDeps: { on: number; when: boolean }[] = []): Event => ({
  id, kind: 'assign', reads, writes: [write], controlDeps,
  apply: (s) => ({ [write]: `e${id}(${reads.map((r) => s.get(r)!).join(',')})` }),
});

const branch = (id: number, read: string): Event => ({
  id, kind: 'branch', reads: [read], writes: [], controlDeps: [],
  decide: (s) => s.get(read)!.length % 2 === 0,
});

const initial: State = new Map([['x', 'x'], ['y', 'y'], ['z', 'z']]);

test('covering write removes stale writer with no remaining contribution', () => {
  const trace: Event[] = [
    konst(0, 'x'),
    konst(1, 'x'),
    use(2, ['x'], 'y'),
  ];
  validateTrace(trace);
  const slice = dynamicSlice(trace, { event: 2, var: 'y' });
  assert.deepEqual([...slice].sort((a, b) => a - b), [1, 2]);
  assert.ok(!slice.has(0), 'event 0 write to x is covered by event 1 and must be dropped');
  const check = verifySliceReplay(trace, slice, { event: 2, var: 'y' }, initial);
  assert.ok(check.ok, `replay mismatch: ${check.expected} vs ${check.actual}`);
});

test('stale writer kept only while it still contributes', () => {
  const trace: Event[] = [
    konst(0, 'x'),
    use(1, ['x'], 'y'),
    konst(2, 'x'),
    use(3, ['x', 'y'], 'z'),
  ];
  const slice = dynamicSlice(trace, { event: 3, var: 'z' });
  assert.deepEqual([...slice].sort((a, b) => a - b), [0, 1, 2, 3]);
});

test('control dependency is preserved in the slice', () => {
  const trace: Event[] = [
    konst(0, 'x'),
    branch(1, 'x'),
    use(2, ['y'], 'z', [{ on: 1, when: true }]),
  ];
  validateTrace(trace);
  const slice = dynamicSlice(trace, { event: 2, var: 'z' });
  assert.ok(slice.has(1), 'branch controlling event 2 must be kept');
  assert.ok(slice.has(0), 'branch read dependency must be kept');
  const withoutBranch = new Set([...slice].filter((id) => id !== 1));
  const r = replay(trace, withoutBranch, initial, { event: 2, var: 'z' });
  assert.ok(!r.watchExecuted, 'controlled event must be skipped once its branch is deleted');
});

test('events after the criterion and unrelated events are excluded', () => {
  const trace: Event[] = [
    konst(0, 'x'),
    use(1, ['x'], 'y'),
    konst(2, 'z'),
    use(3, ['z'], 'z'),
  ];
  const slice = dynamicSlice(trace, { event: 1, var: 'y' });
  assert.deepEqual([...slice].sort((a, b) => a - b), [0, 1]);
});

test('delete-then-replay reproduces the sliced output', () => {
  const trace: Event[] = [
    konst(0, 'x'),
    use(1, ['x'], 'y'),
    branch(2, 'y'),
    use(3, ['y'], 'z', [{ on: 2, when: true }]),
    konst(4, 'x'),
    use(5, ['x'], 'x'),
  ];
  validateTrace(trace);
  const criterion = { event: 3, var: 'z' };
  const slice = dynamicSlice(trace, criterion);
  assert.deepEqual([...slice].sort((a, b) => a - b), [0, 1, 2, 3]);
  const check = verifySliceReplay(trace, slice, criterion, initial);
  assert.ok(check.ok, `expected ${check.expected}, got ${check.actual}`);
  assert.equal(valueAt(trace, slice, criterion, initial), 'e3(e1(e0()))');
  const min = checkMinimality(trace, slice, criterion, initial);
  assert.ok(min.ok, `not minimal, counterexample: ${min.counterexample}`);
  assert.equal(min.mode, 'exhaustive');
  assert.equal(min.checked, 15);
});

test('validateTrace rejects malformed traces', () => {
  assert.throws(() => validateTrace([{ ...konst(1, 'x') }]));
  assert.throws(() => validateTrace([use(0, [], 'x', [{ on: 0, when: true }])]));
});
