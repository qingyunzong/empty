import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RelationStore,
  applyDelta,
  invertDelta,
  snapshotsEqual,
  type BatchOp,
  type Delta,
  type Edge,
  type Snapshot,
} from '../src/store.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent set-difference reference model used to cross-check the store. */
function referenceDiff(before: Snapshot, after: Snapshot): Delta {
  const beforeIds = new Set(before.keys());
  const afterIds = new Set(after.keys());
  const added: Edge[] = [];
  const removed: Edge[] = [];
  const relabeled: Delta['relabeled'][number][] = [];

  for (const id of afterIds) {
    const now = after.get(id)!;
    if (!beforeIds.has(id)) {
      added.push(now);
      continue;
    }
    const old = before.get(id)!;
    if (old.from !== now.from || old.to !== now.to) {
      removed.push(old);
      added.push(now);
    } else if (old.label !== now.label) {
      relabeled.push({ id, from: now.from, to: now.to, oldLabel: old.label, newLabel: now.label });
    }
  }
  for (const id of beforeIds) {
    if (!afterIds.has(id)) removed.push(before.get(id)!);
  }
  return { added, removed, relabeled };
}

function canonical(d: Delta): string {
  const sortEdges = (xs: readonly Edge[]) =>
    [...xs].sort((p, q) => p.id.localeCompare(q.id)).map((x) => [x.id, x.from, x.to, x.label]);
  const sortRelabels = (xs: Delta['relabeled']) =>
    [...xs]
      .sort((p, q) => p.id.localeCompare(q.id))
      .map((x) => [x.id, x.from, x.to, x.oldLabel, x.newLabel]);
  return JSON.stringify({
    added: sortEdges(d.added),
    removed: sortEdges(d.removed),
    relabeled: sortRelabels(d.relabeled),
  });
}

test('random version histories match the set-difference reference model', () => {
  const TRIALS = 30;
  for (let trial = 0; trial < TRIALS; trial++) {
    const rand = mulberry32(0x9e3779b9 ^ trial);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const nodes = Array.from({ length: 6 }, (_, i) => `n${i}`);
    const labels = Array.from({ length: 4 }, (_, i) => `L${i}`);

    const store = new RelationStore();
    let edgeCounter = 0;
    const commits = 5 + Math.floor(rand() * 20);

    for (let c = 0; c < commits; c++) {
      const batch: BatchOp[] = [];
      const ops = Math.floor(rand() * 7);
      for (let k = 0; k < ops; k++) {
        const live = [...store.snapshot().keys()];
        const roll = rand();
        if (roll < 0.5 || live.length === 0) {
          batch.push({
            type: 'add',
            edge: {
              id: `t${trial}e${edgeCounter++}`,
              from: pick(nodes),
              to: pick(nodes), // self-loops and cycles arise naturally
              label: pick(labels),
            },
          });
        } else if (roll < 0.75) {
          batch.push({ type: 'remove', id: pick(live) });
        } else {
          batch.push({ type: 'relabel', id: pick(live), label: pick(labels) });
        }
      }
      try {
        store.commit(batch);
      } catch {
        // Random duplicate ops inside one batch may invalidate it; the
        // atomicity contract then guarantees the store is untouched.
        continue;
      }
    }

    const versions = Array.from({ length: store.current + 1 }, (_, i) => i);
    const pairs = Math.min(20, versions.length * versions.length);
    for (let p = 0; p < pairs; p++) {
      const a = pick(versions);
      const b = pick(versions);
      const snapA = store.snapshot(a);
      const snapB = store.snapshot(b);

      const actual = store.diff(a, b);
      const expected = referenceDiff(snapA, snapB);
      assert.equal(
        canonical(actual),
        canonical(expected),
        `diff mismatch trial=${trial} from=${a} to=${b}`,
      );

      // Forward application reaches the post-image; the inverse delta
      // applied to the post-image restores the pre-image.
      assert.ok(
        snapshotsEqual(applyDelta(snapA, actual), snapB),
        `forward apply failed trial=${trial} from=${a} to=${b}`,
      );
      assert.ok(
        snapshotsEqual(applyDelta(snapB, invertDelta(actual)), snapA),
        `inverse apply failed trial=${trial} from=${a} to=${b}`,
      );
      assert.ok(store.validateInverse(a, b), `validateInverse failed trial=${trial} a=${a} b=${b}`);
    }
  }
});

test('random invalid batches leave the store untouched (atomicity)', () => {
  const rand = mulberry32(42);
  const store = new RelationStore();
  store.commit([
    { type: 'add', edge: { id: 'e1', from: 'a', to: 'b', label: 'L0' } },
    { type: 'add', edge: { id: 'e2', from: 'b', to: 'b', label: 'L1' } },
  ]);

  for (let i = 0; i < 200; i++) {
    const versionBefore = store.current;
    const snapshotBefore = store.snapshot();
    const badBatches: BatchOp[][] = [
      [{ type: 'remove', id: 'ghost' }],
      [{ type: 'relabel', id: 'ghost', label: 'X' }],
      [{ type: 'add', edge: { id: 'e1', from: 'x', to: 'y', label: 'L' } }],
      [
        { type: 'add', edge: { id: 'dup', from: 'x', to: 'y', label: 'L' } },
        { type: 'add', edge: { id: 'dup', from: 'x', to: 'y', label: 'L' } },
      ],
    ];
    const batch: BatchOp[] = [
      { type: 'add', edge: { id: `ok${i}`, from: 'a', to: 'a', label: 'L' } },
      ...badBatches[Math.floor(rand() * badBatches.length)],
    ];
    assert.throws(() => store.commit(batch));
    assert.equal(store.current, versionBefore);
    assert.ok(snapshotsEqual(store.snapshot(), snapshotBefore));
  }
});
