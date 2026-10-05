import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSamples,
  BenchmarkStore,
  DuplicateRoundError,
  DuplicateSampleError,
  InvalidSampleError,
  UnknownSampleError,
  type Sample,
} from '../src/benchmark.js';
import {
  averageRanks,
  averageRanksByCounting,
  exactMedian,
  wilcoxonSignedRankExact,
} from '../src/stats.js';

function sample(partial: Partial<Sample> & Pick<Sample, 'id'>): Sample {
  return {
    env: 'linux-x64',
    input: 'sha256-1MiB',
    round: 0,
    side: 'A',
    durationMs: 100,
    ...partial,
  };
}

test('exactMedian: odd, even, empty', () => {
  assert.equal(exactMedian([3, 1, 2]), 2);
  assert.equal(exactMedian([4, 1, 3, 2]), 2.5);
  assert.equal(exactMedian([7]), 7);
  assert.equal(exactMedian([]), null);
});

test('averageRanks: ties share the average rank', () => {
  assert.deepEqual(averageRanks([2, 2, 3]), [1.5, 1.5, 3]);
  assert.deepEqual(averageRanks([5, 1, 5, 5]), [3, 1, 3, 3]);
  assert.deepEqual(averageRanks([]), []);
});

test('independent counting ranker agrees with sort-based ranker (seeded fuzz)', () => {
  let state = 0x2f6e2b1;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  for (let trial = 0; trial < 300; trial += 1) {
    const length = next() % 12;
    const values = Array.from({ length }, () => next() % 4);
    assert.deepEqual(averageRanks(values), averageRanksByCounting(values));
  }
});

test('wilcoxon exact: diffs [1,2,3] gives p = 2/8', () => {
  const outcome = wilcoxonSignedRankExact([1, 2, 3])!;
  assert.equal(outcome.n, 3);
  assert.equal(outcome.droppedZeros, 0);
  assert.deepEqual(outcome.ranks, [1, 2, 3]);
  assert.equal(outcome.tPlus, 6);
  assert.equal(outcome.tMinus, 0);
  assert.equal(outcome.statistic, 6);
  assert.equal(outcome.permutations, 8);
  assert.equal(outcome.extremeCount, 2);
  assert.equal(outcome.pValue, 0.25);
});

test('wilcoxon exact: tied absolute values use average ranks, p = 6/8', () => {
  const outcome = wilcoxonSignedRankExact([2, -2, 3])!;
  assert.deepEqual(outcome.ranks, [1.5, 1.5, 3]);
  assert.equal(outcome.tPlus, 4.5);
  assert.equal(outcome.tMinus, 1.5);
  assert.equal(outcome.statistic, 3);
  assert.equal(outcome.extremeCount, 6);
  assert.equal(outcome.pValue, 0.75);
});

test('wilcoxon exact: zero diffs are dropped before ranking', () => {
  const outcome = wilcoxonSignedRankExact([0, 5])!;
  assert.equal(outcome.n, 1);
  assert.equal(outcome.droppedZeros, 1);
  assert.equal(outcome.permutations, 2);
  assert.equal(outcome.pValue, 1);
  assert.equal(wilcoxonSignedRankExact([0, 0, 0]), null);
});

test('pairing by env/input/round; missing side stays unpaired, never zero-filled', () => {
  const store = new BenchmarkStore();
  store.submit(sample({ id: 'a-r0', round: 0, side: 'A', durationMs: 120 }));
  const snap = store.latest()!;
  assert.equal(snap.groups.length, 1);
  const group = snap.groups[0];
  assert.equal(group.pairs.length, 0);
  assert.equal(group.unpaired.length, 1);
  assert.deepEqual(group.unpaired[0], { round: 0, side: 'A', sampleId: 'a-r0', durationMs: 120 });
  assert.equal(group.medianDiff, null);
  assert.equal(group.wilcoxon, null);
});

test('late submission completes the pair atomically; old snapshot is retained', () => {
  const store = new BenchmarkStore();
  const snap1 = store.submit(sample({ id: 'a-r0', round: 0, side: 'A', durationMs: 120 }));
  const snap2 = store.submit(sample({ id: 'b-r0', round: 0, side: 'B', durationMs: 100 }));
  assert.equal(snap2.groups[0].pairs.length, 1);
  assert.deepEqual(snap2.groups[0].pairs[0], {
    round: 0, aId: 'a-r0', bId: 'b-r0', aMs: 120, bMs: 100, diff: 20,
  });
  assert.equal(snap2.groups[0].unpaired.length, 0);
  const retained = store.getSnapshot(snap1.seq)!;
  assert.equal(retained.groups[0].pairs.length, 0);
  assert.equal(retained.groups[0].unpaired.length, 1);
  assert.equal(store.snapshots().length, 2);
});

test('duplicate round conflict is rejected and leaves state untouched', () => {
  const store = new BenchmarkStore();
  store.submit(sample({ id: 'a-r0', round: 0, side: 'A' }));
  assert.throws(
    () => store.submit(sample({ id: 'a-r0-again', round: 0, side: 'A' })),
    DuplicateRoundError,
  );
  assert.equal(store.size, 1);
  assert.equal(store.snapshots().length, 1);
  assert.equal(store.has('a-r0-again'), false);
});

test('duplicate sample id and invalid durations are rejected', () => {
  const store = new BenchmarkStore();
  store.submit(sample({ id: 'a-r0' }));
  assert.throws(() => store.submit(sample({ id: 'a-r0', round: 1 })), DuplicateSampleError);
  assert.throws(() => store.submit(sample({ id: 'bad', round: 1, durationMs: 1.5 })), InvalidSampleError);
  assert.throws(() => store.submit(sample({ id: 'neg', round: 1, durationMs: -3 })), InvalidSampleError);
  assert.equal(store.size, 1);
});

test('withdrawal atomically breaks the pair; earlier snapshots keep old analysis', () => {
  const store = new BenchmarkStore();
  store.submit(sample({ id: 'a-r0', round: 0, side: 'A', durationMs: 120 }));
  const pairedSnap = store.submit(sample({ id: 'b-r0', round: 0, side: 'B', durationMs: 100 }));
  const afterWithdraw = store.withdraw('a-r0');
  assert.equal(afterWithdraw.groups[0].pairs.length, 0);
  assert.deepEqual(afterWithdraw.groups[0].unpaired, [
    { round: 0, side: 'B', sampleId: 'b-r0', durationMs: 100 },
  ]);
  const retained = store.getSnapshot(pairedSnap.seq)!;
  assert.equal(retained.groups[0].pairs.length, 1);
  assert.throws(() => store.withdraw('a-r0'), UnknownSampleError);
});

test('groups are split by env and input, sorted deterministically', () => {
  const analyses = analyzeSamples([
    sample({ id: 'a1', env: 'macos-arm', input: 'x', round: 0, side: 'A', durationMs: 10 }),
    sample({ id: 'b1', env: 'macos-arm', input: 'x', round: 0, side: 'B', durationMs: 8 }),
    sample({ id: 'a2', env: 'linux-x64', input: 'y', round: 0, side: 'A', durationMs: 30 }),
    sample({ id: 'b2', env: 'linux-x64', input: 'y', round: 0, side: 'B', durationMs: 20 }),
  ]);
  assert.equal(analyses.length, 2);
  assert.equal(analyses[0].env, 'linux-x64');
  assert.equal(analyses[1].env, 'macos-arm');
  assert.equal(analyses[0].medianDiff, 10);
  assert.equal(analyses[1].medianDiff, 2);
});

test('evidence: sample ids, exhaustive permutation counts, exact median', () => {
  const store = new BenchmarkStore();
  const diffs = [1, 2, 3, 4];
  diffs.forEach((d, i) => {
    store.submit(sample({ id: `a-r${i}`, round: i, side: 'A', durationMs: 100 + d }));
    store.submit(sample({ id: `b-r${i}`, round: i, side: 'B', durationMs: 100 }));
  });
  const group = store.latest()!.groups[0];
  assert.equal(group.medianDiff, 2.5);
  const w = group.wilcoxon!;
  assert.equal(w.n, 4);
  assert.equal(w.permutations, 16);
  assert.equal(w.extremeCount, 2);
  assert.equal(w.pValue, 0.125);
  assert.equal(w.statistic, 10);
  assert.deepEqual(w.entries.map((e) => [e.aId, e.bId]), [
    ['a-r0', 'b-r0'], ['a-r1', 'b-r1'], ['a-r2', 'b-r2'], ['a-r3', 'b-r3'],
  ]);
  assert.deepEqual(w.entries.map((e) => e.rank), [1, 2, 3, 4]);
});

test('zero-diff rounds are reported as dropped, not ranked', () => {
  const store = new BenchmarkStore();
  store.submit(sample({ id: 'a-r0', round: 0, side: 'A', durationMs: 50 }));
  store.submit(sample({ id: 'b-r0', round: 0, side: 'B', durationMs: 50 }));
  store.submit(sample({ id: 'a-r1', round: 1, side: 'A', durationMs: 60 }));
  store.submit(sample({ id: 'b-r1', round: 1, side: 'B', durationMs: 50 }));
  const w = store.latest()!.groups[0].wilcoxon!;
  assert.deepEqual(w.droppedZeroDiffRounds, [0]);
  assert.equal(w.n, 1);
  assert.deepEqual(w.entries.map((e) => e.round), [1]);
});

test('audit on a healthy store finds no corrections', () => {
  const store = new BenchmarkStore();
  store.submit(sample({ id: 'a-r0', round: 0, side: 'A', durationMs: 110 }));
  store.submit(sample({ id: 'b-r0', round: 0, side: 'B', durationMs: 100 }));
  const report = store.auditRanks();
  assert.equal(report.checkedGroups, 1);
  assert.equal(report.corrections.length, 0);
  assert.equal(report.correctedSnapshot, null);
});

test('audit corrects whole-group rank drift via independent re-ranking', () => {
  const store = new BenchmarkStore();
  [3, 1, 2].forEach((d, i) => {
    store.submit(sample({ id: `a-r${i}`, round: i, side: 'A', durationMs: 100 + d }));
    store.submit(sample({ id: `b-r${i}`, round: i, side: 'B', durationMs: 100 }));
  });
  const before = store.snapshots().length;
  const internals = store as unknown as { history: { groups: { wilcoxon: { entries: { rank: number }[] } | null }[] }[] };
  internals.history[internals.history.length - 1].groups[0].wilcoxon!.entries[0].rank = 99;
  const report = store.auditRanks();
  assert.equal(report.corrections.length, 1);
  assert.deepEqual(report.corrections[0].beforeRanks, [99, 1, 2]);
  assert.deepEqual(report.corrections[0].afterRanks, [3, 1, 2]);
  assert.ok(report.correctedSnapshot);
  assert.equal(report.correctedSnapshot!.kind, 'audit-correction');
  assert.deepEqual(
    report.correctedSnapshot!.groups[0].wilcoxon!.entries.map((e) => e.rank),
    [3, 1, 2],
  );
  assert.equal(store.snapshots().length, before + 1);
  const followUp = store.auditRanks();
  assert.equal(followUp.corrections.length, 0);
});
