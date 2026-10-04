import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BenchmarkStore,
  DuplicateRoundConflictError,
  DuplicateSampleIdError,
  UnknownSampleError,
  ValidationError,
  formatReport,
  type Sample,
} from "../src/index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-store-"));
}

function sample(partial: Partial<Sample> & { id: string }): Sample {
  return {
    env: "linux-x64",
    inputDigest: "sha256:abc",
    round: 0,
    arm: "A",
    durationMs: 100,
    ...partial,
  };
}

test("pairs A/B by env, digest and round; missing side stays empty", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0", arm: "A", round: 0, durationMs: 120 }));
  store.submit(sample({ id: "b0", arm: "B", round: 0, durationMs: 100 }));
  store.submit(sample({ id: "a1", arm: "A", round: 1, durationMs: 130 }));

  const [group] = store.analyze();
  assert.equal(group.pairs.length, 2);
  const pair1 = group.pairs[1];
  assert.equal(pair1.aMs, 130);
  assert.equal(pair1.bMs, null);
  assert.equal(pair1.bSampleId, null);
  assert.equal(pair1.diff, null);
  assert.equal(group.missingB, 1);
  assert.equal(group.medianDiff, 20);
});

test("separate env or digest forms separate groups", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0", env: "linux", arm: "A", durationMs: 10 }));
  store.submit(sample({ id: "b0", env: "linux", arm: "B", durationMs: 8 }));
  store.submit(sample({ id: "a1", env: "macos", arm: "A", durationMs: 30 }));
  store.submit(sample({ id: "b1", env: "macos", arm: "B", durationMs: 20 }));
  store.submit(sample({ id: "a2", env: "macos", inputDigest: "sha256:other", arm: "A", durationMs: 5 }));
  const groups = store.analyze();
  assert.equal(groups.length, 3);
});

test("duplicate round conflict is rejected atomically", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0", arm: "A", round: 0 }));
  const versionBefore = store.currentVersion;
  assert.throws(
    () => store.submit(sample({ id: "a0b", arm: "A", round: 0, durationMs: 999 })),
    DuplicateRoundConflictError,
  );
  assert.equal(store.currentVersion, versionBefore);
  assert.equal(store.getSample("a0b"), undefined);
  assert.deepEqual(store.listSnapshots(), [1]);
  store.submit(sample({ id: "b0", arm: "B", round: 0 }));
  assert.equal(store.currentVersion, 2);
});

test("duplicate sample id and invalid payloads are rejected", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0" }));
  assert.throws(() => store.submit(sample({ id: "a0", round: 5 })), DuplicateSampleIdError);
  assert.throws(() => store.submit(sample({ id: "x", durationMs: 1.5 })), ValidationError);
  assert.throws(() => store.submit(sample({ id: "y", round: -1 })), ValidationError);
  assert.throws(() => store.submit(sample({ id: "z", round: 0.5 })), ValidationError);
  assert.equal(store.currentVersion, 1);
});

test("withdraw maintains pairing and ranks atomically", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0", arm: "A", round: 0, durationMs: 110 }));
  store.submit(sample({ id: "b0", arm: "B", round: 0, durationMs: 100 }));
  store.submit(sample({ id: "a1", arm: "A", round: 1, durationMs: 150 }));
  store.submit(sample({ id: "b1", arm: "B", round: 1, durationMs: 100 }));

  let [group] = store.analyze();
  assert.equal(group.completePairs, 2);
  assert.deepEqual(group.pairs.map((p) => p.absRank), [1, 2]);

  store.withdraw("b1");
  [group] = store.analyze();
  assert.equal(group.completePairs, 1);
  assert.equal(group.missingB, 1);
  assert.equal(group.pairs[0].absRank, 1);
  assert.equal(group.pairs[1].absRank, null);
  assert.equal(group.medianDiff, 10);

  store.withdraw("a1");
  [group] = store.analyze();
  assert.equal(group.pairs.length, 1);

  assert.throws(() => store.withdraw("missing"), UnknownSampleError);
});

test("withdrawing the last sample of a group removes the group", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0" }));
  store.withdraw("a0");
  assert.equal(store.analyze().length, 0);
});

test("persistent snapshots retain old analyses", () => {
  const dir = tmpDir();
  const store = BenchmarkStore.open(dir);
  store.submit(sample({ id: "a0", arm: "A", round: 0, durationMs: 110 }));
  store.submit(sample({ id: "b0", arm: "B", round: 0, durationMs: 100 }));
  store.submit(sample({ id: "a1", arm: "A", round: 1, durationMs: 160 }));
  store.submit(sample({ id: "b1", arm: "B", round: 1, durationMs: 100 }));

  assert.deepEqual(store.listSnapshots(), [1, 2, 3, 4]);
  const v2 = store.snapshot(2)!;
  assert.equal(v2.analyses[0].completePairs, 1);
  assert.equal(v2.analyses[0].medianDiff, 10);
  const v4 = store.snapshot(4)!;
  assert.equal(v4.analyses[0].completePairs, 2);
  assert.equal(v4.analyses[0].medianDiff, 35);
  assert.equal(store.snapshot(99), null);

  const files = fs.readdirSync(dir).filter((f) => f.startsWith("snapshot-"));
  assert.equal(files.length, 4);
});

test("store reopens from the latest snapshot", () => {
  const dir = tmpDir();
  const store = BenchmarkStore.open(dir);
  store.submit(sample({ id: "a0", arm: "A", round: 0, durationMs: 110 }));
  store.submit(sample({ id: "b0", arm: "B", round: 0, durationMs: 100 }));

  const reopened = BenchmarkStore.open(dir);
  assert.equal(reopened.currentVersion, 2);
  const [group] = reopened.analyze();
  assert.equal(group.completePairs, 1);
  assert.equal(group.medianDiff, 10);
  reopened.submit(sample({ id: "a1", arm: "A", round: 1, durationMs: 90 }));
  assert.equal(reopened.currentVersion, 3);
});

test("verify recomputes full ranks and corrects drifted groups", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0", arm: "A", round: 0, durationMs: 110 }));
  store.submit(sample({ id: "b0", arm: "B", round: 0, durationMs: 100 }));
  store.submit(sample({ id: "a1", arm: "A", round: 1, durationMs: 150 }));
  store.submit(sample({ id: "b1", arm: "B", round: 1, durationMs: 100 }));

  const clean = store.verify();
  assert.equal(clean.checkedGroups, 1);
  assert.deepEqual(clean.correctedGroups, []);
  assert.equal(clean.snapshotVersion, null);

  const internal = store as unknown as {
    state: { analyses: Map<string, unknown> };
  };
  const key = "linux-x64::sha256:abc";
  const drifted = structuredClone(store.analyze()[0]);
  (drifted as { medianDiff: number }).medianDiff = -777;
  internal.state.analyses.set(key, drifted);
  assert.equal(store.analyze()[0].medianDiff, -777);

  const report = store.verify();
  assert.deepEqual(report.correctedGroups, [key]);
  assert.equal(report.snapshotVersion, 5);
  assert.equal(store.analyze()[0].medianDiff, 30);
  assert.equal(store.snapshot(5)!.analyses[0].medianDiff, 30);
});

test("wilcoxon evidence carries sample ids and exhaustive counts", () => {
  const store = BenchmarkStore.open(tmpDir());
  const durations: Array<[number, number]> = [
    [13, 10],
    [9, 10],
    [14, 10],
    [8, 10],
    [15, 10],
  ];
  durations.forEach(([a, b], round) => {
    store.submit(sample({ id: `a${round}`, arm: "A", round, durationMs: a }));
    store.submit(sample({ id: `b${round}`, arm: "B", round, durationMs: b }));
  });

  const [group] = store.analyze();
  const w = group.wilcoxon!;
  assert.equal(w.n, 5);
  assert.equal(w.totalReassignments, "32");
  assert.equal(Number(w.extremeCount) / Number(w.totalReassignments), w.pValue);
  assert.deepEqual(
    w.evidence.map((e) => e.aSampleId).sort(),
    ["a0", "a1", "a2", "a3", "a4"],
  );
  assert.equal(group.medianDiff, 3);
});

test("zero diffs are dropped from ranks but kept in median", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0", arm: "A", round: 0, durationMs: 100 }));
  store.submit(sample({ id: "b0", arm: "B", round: 0, durationMs: 100 }));
  store.submit(sample({ id: "a1", arm: "A", round: 1, durationMs: 120 }));
  store.submit(sample({ id: "b1", arm: "B", round: 1, durationMs: 100 }));

  const [group] = store.analyze();
  assert.equal(group.medianDiff, 10);
  assert.equal(group.pairs[0].absRank, null);
  assert.equal(group.pairs[1].absRank, 1);
  assert.equal(group.wilcoxon!.n, 1);
  assert.equal(group.wilcoxon!.zeroDiffsDropped, 1);
});

test("report leaves missing cells empty instead of zero", () => {
  const store = BenchmarkStore.open(tmpDir());
  store.submit(sample({ id: "a0", arm: "A", round: 0, durationMs: 105 }));
  store.submit(sample({ id: "b0", arm: "B", round: 0, durationMs: 100 }));
  store.submit(sample({ id: "a1", arm: "A", round: 1, durationMs: 110 }));
  const report = formatReport(store.analyze());
  assert.match(report, /1 \| a1 \| 110 \|  \|  \|  \|/);
  assert.doesNotMatch(report, /\| 0 \| 0 \|/);
  assert.match(report, /medianDiff=5/);
});
