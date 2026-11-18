import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineStore, TimelineError } from '../src/timeline.ts';

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof TimelineError, `expected TimelineError, got ${err}`);
    return (err as TimelineError).code;
  }
  throw new Error('expected the call to throw');
}

test('archive gap blocks recovery beyond the gap until it is filled', () => {
  const store = new TimelineStore();
  store.createRoot('t1');
  store.archiveSegment('t1', 0, 10);
  store.archiveSegment('t1', 20, 30);

  assert.equal(store.recoverableUpTo('t1'), 10);
  assert.ok(store.isRecoverable('t1', 10));
  assert.ok(!store.isRecoverable('t1', 11));
  assert.ok(!store.isRecoverable('t1', 25));

  store.archiveSegment('t1', 10, 20);
  assert.equal(store.recoverableUpTo('t1'), 30);
  assert.ok(store.isRecoverable('t1', 25));
});

test('branch requires a sealed parent and a valid recoverable point', () => {
  const store = new TimelineStore();
  store.createRoot('t1');
  store.archiveSegment('t1', 0, 10);
  store.archiveSegment('t1', 20, 30);

  assert.equal(codeOf(() => store.createBranch('t2', 't1', 5)), 'PARENT_NOT_SEALED');
  store.seal('t1');

  assert.equal(codeOf(() => store.createBranch('t2', 't1', 15)), 'INVALID_BRANCH_POINT');
  assert.equal(codeOf(() => store.createBranch('t2', 't1', 31)), 'INVALID_BRANCH_POINT');
  assert.equal(codeOf(() => store.createBranch('t2', 't1', -1)), 'INVALID_BRANCH_POINT');

  store.createBranch('t2', 't1', 10);
  assert.equal(codeOf(() => store.createBranch('t2', 't1', 10)), 'DUPLICATE_TIMELINE');
  assert.deepEqual(store.parentOf('t2'), { parentId: 't1', branchLsn: 10 });
});

test('branch point must lie on the parent timeline itself', () => {
  const store = new TimelineStore();
  store.createRoot('t1');
  store.archiveSegment('t1', 0, 10);
  store.seal('t1');
  store.createBranch('t2', 't1', 5);
  store.archiveSegment('t2', 5, 12);
  store.seal('t2');

  assert.equal(codeOf(() => store.createBranch('t3', 't2', 3)), 'INVALID_BRANCH_POINT');
  store.createBranch('t3', 't2', 12);
  assert.deepEqual(store.reachableFrom('t1').sort(), ['t2', 't3']);
});

test('sealed timelines are never rewritten by late archive arrivals', () => {
  const store = new TimelineStore();
  store.createRoot('t1');
  store.archiveSegment('t1', 0, 10);
  store.seal('t1');
  store.createBranch('t2', 't1', 10);

  const before = JSON.stringify(store.snapshot());
  assert.equal(codeOf(() => store.archiveSegment('t1', 10, 20)), 'TIMELINE_SEALED');
  assert.equal(JSON.stringify(store.snapshot()), before);

  store.archiveSegment('t2', 10, 20);
  assert.equal(store.recoverableUpTo('t2'), 20);
  assert.equal(store.recoverableUpTo('t1'), 10);
});

test('recovery path reports timeline switches at branch points', () => {
  const store = new TimelineStore();
  store.createRoot('t1');
  store.archiveSegment('t1', 0, 10);
  store.seal('t1');
  store.createBranch('t2', 't1', 10);
  store.archiveSegment('t2', 10, 20);
  store.seal('t2');
  store.createBranch('t3', 't2', 15);
  store.archiveSegment('t3', 15, 25);

  assert.deepEqual(store.recoveryPath('t3', 22), [
    { timelineId: 't1', fromLsn: 0, toLsn: 10 },
    { timelineId: 't2', fromLsn: 10, toLsn: 15 },
    { timelineId: 't3', fromLsn: 15, toLsn: 22 },
  ]);
  assert.equal(store.recoveryPath('t3', 26), null);
  assert.deepEqual(store.findRecoverableTimelines(18).sort(), ['t2', 't3']);
  assert.deepEqual(store.findRecoverableTimelines(8).sort(), ['t1', 't2', 't3']);
});

test('child history before the branch point resolves through ancestors', () => {
  const store = new TimelineStore();
  store.createRoot('t1');
  store.archiveSegment('t1', 0, 10);
  store.seal('t1');
  store.createBranch('t2', 't1', 10);

  assert.ok(store.isRecoverable('t2', 7));
  assert.ok(!store.isRecoverable('t2', 11));
  assert.equal(codeOf(() => store.archiveSegment('t2', 4, 8)), 'INVALID_SEGMENT');
});

test('snapshot round-trips through restore and validates structure', () => {
  const store = new TimelineStore();
  store.createRoot('t1');
  store.archiveSegment('t1', 0, 10);
  store.seal('t1');
  store.createBranch('t2', 't1', 10);
  store.archiveSegment('t2', 10, 14);

  const restored = TimelineStore.restore(store.snapshot());
  assert.deepEqual(restored.snapshot(), store.snapshot());
  assert.equal(restored.recoverableUpTo('t2'), 14);

  const cyclic = {
    timelines: [
      { id: 'a', parentId: 'b', branchLsn: 1, sealed: true, segments: [] },
      { id: 'b', parentId: 'a', branchLsn: 1, sealed: true, segments: [] },
    ],
  };
  assert.equal(codeOf(() => TimelineStore.restore(cyclic)), 'INVALID_SNAPSHOT');
});

test('unknown timelines and malformed segments are rejected', () => {
  const store = new TimelineStore();
  assert.equal(codeOf(() => store.archiveSegment('nope', 0, 1)), 'UNKNOWN_TIMELINE');
  assert.equal(codeOf(() => store.seal('nope')), 'UNKNOWN_TIMELINE');
  store.createRoot('t1');
  assert.equal(codeOf(() => store.archiveSegment('t1', 5, 5)), 'INVALID_SEGMENT');
  assert.equal(codeOf(() => store.archiveSegment('t1', 6, 2)), 'INVALID_SEGMENT');
  assert.equal(codeOf(() => store.archiveSegment('t1', -3, 2)), 'INVALID_SEGMENT');
  store.validate();
});
