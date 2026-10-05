import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  RelationStore,
  Version,
  applyDiff,
  diff,
  invert,
  type BatchOp,
  type Diff,
  type Edge,
} from './store';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
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

/* ------------------------------------------------------------------ */
/* Reference model: a version is a plain map id -> [from, to, label]; */
/* the reference diff is a pure set difference over id-keyed tuples.  */
/* ------------------------------------------------------------------ */

type RefEdge = readonly [string, string, string];
type RefVersion = ReadonlyMap<string, RefEdge>;

interface RefDiff {
  added: Array<[string, RefEdge]>;
  removed: Array<[string, RefEdge]>;
  relabeled: Array<[string, RefEdge, RefEdge]>;
}

function snapshot(version: Version): RefVersion {
  const m = new Map<string, RefEdge>();
  for (const edge of version.entries()) {
    m.set(edge.id, [edge.from, edge.to, edge.label]);
  }
  return m;
}

function refDiff(a: RefVersion, b: RefVersion): RefDiff {
  const added: Array<[string, RefEdge]> = [];
  const removed: Array<[string, RefEdge]> = [];
  const relabeled: Array<[string, RefEdge, RefEdge]> = [];
  for (const [id, tb] of b) {
    const ta = a.get(id);
    if (ta === undefined) {
      added.push([id, tb]);
    } else if (ta[0] !== tb[0] || ta[1] !== tb[1]) {
      removed.push([id, ta]);
      added.push([id, tb]);
    } else if (ta[2] !== tb[2]) {
      relabeled.push([id, ta, tb]);
    }
  }
  for (const [id, ta] of a) {
    if (!b.has(id)) removed.push([id, ta]);
  }
  const byKey = (x: [string, ...unknown[]], y: [string, ...unknown[]]) =>
    x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
  added.sort(byKey);
  removed.sort(byKey);
  relabeled.sort(byKey);
  return { added, removed, relabeled };
}

function normalize(d: Diff): RefDiff {
  const pack = (edge: Edge): [string, RefEdge] => [edge.id, [edge.from, edge.to, edge.label]];
  return {
    added: d.added.map(pack),
    removed: d.removed.map(pack),
    relabeled: d.relabeled.map((r) => [r.id, pack(r.from)[1], pack(r.to)[1]]),
  };
}

/* ------------------------------------------------------------------ */
/* Random version chains built through the store's atomic batches.    */
/* ------------------------------------------------------------------ */

const NODES = ['n0', 'n1', 'n2', 'n3', 'n4'];
const LABELS = ['L0', 'L1', 'L2', 'L3'];

function randomBatch(rand: () => number, version: Version, counter: { next: number }): BatchOp[] {
  const ops: BatchOp[] = [];
  const opCount = 1 + Math.floor(rand() * 6);
  const ids = [...version.entries()].map((edge) => edge.id);
  const usedInBatch = new Set<string>();
  for (let i = 0; i < opCount; i++) {
    const roll = rand();
    if (roll < 0.45 || ids.length === 0) {
      const id = `e${counter.next++}`;
      usedInBatch.add(id);
      // Self-loops and cycles appear naturally: from/to are drawn independently.
      ops.push({
        kind: 'add',
        edge: {
          id,
          from: NODES[Math.floor(rand() * NODES.length)]!,
          to: NODES[Math.floor(rand() * NODES.length)]!,
          label: LABELS[Math.floor(rand() * LABELS.length)]!,
        },
      });
    } else if (roll < 0.75) {
      const id = ids[Math.floor(rand() * ids.length)]!;
      if (usedInBatch.has(id)) continue;
      usedInBatch.add(id);
      ops.push({ kind: 'relabel', id, label: LABELS[Math.floor(rand() * LABELS.length)]! });
    } else {
      const id = ids[Math.floor(rand() * ids.length)]!;
      if (usedInBatch.has(id)) continue;
      usedInBatch.add(id);
      ops.push({ kind: 'remove', id });
    }
  }
  return ops;
}

function randomChain(rand: () => number, length: number): Version[] {
  const store = new RelationStore();
  const versions: Version[] = [store.version];
  const counter = { next: 0 };
  for (let i = 0; i < length; i++) {
    store.commit(randomBatch(rand, store.version, counter));
    versions.push(store.version);
  }
  return versions;
}

test('property: store diff matches the set-difference reference model on random versions', () => {
  const SEEDS = 25;
  const CHAIN_LENGTH = 40;
  const PAIRS_PER_CHAIN = 30;
  let checks = 0;

  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed);
    const versions = randomChain(rand, CHAIN_LENGTH);

    for (let p = 0; p < PAIRS_PER_CHAIN; p++) {
      const i = Math.floor(rand() * versions.length);
      const j = Math.floor(rand() * versions.length);
      const a = versions[i]!;
      const b = versions[j]!;

      // 1. Cross-check against the reference model.
      const expected = refDiff(snapshot(a), snapshot(b));
      assert.deepEqual(normalize(diff(a, b)), expected, `diff mismatch seed=${seed} pair=(${i},${j})`);

      // 2. Forward application reaches the target image.
      assert.ok(applyDiff(a, diff(a, b)).equals(b), `forward apply failed seed=${seed} pair=(${i},${j})`);

      // 3. Reverse diff validates the current preimage: invert(diff) applied
      //    to the current version restores the previous version exactly.
      const restored = applyDiff(b, invert(diff(a, b)));
      assert.ok(restored.equals(a), `reverse apply failed seed=${seed} pair=(${i},${j})`);

      checks++;
    }
  }
  console.log(`property test: ${checks} random version pairs cross-checked (${SEEDS} seeds)`);
});

test('property: atomicity holds for randomly corrupted batches', () => {
  const SEEDS = 25;
  let rejected = 0;

  for (let seed = 1000; seed < 1000 + SEEDS; seed++) {
    const rand = mulberry32(seed);
    const store = new RelationStore();
    const counter = { next: 0 };
    for (let step = 0; step < 20; step++) {
      const ops = randomBatch(rand, store.version, counter);
      if (rand() < 0.5 && ops.length > 0) {
        // Corrupt the batch: add an op that must be rejected.
        ops.push({ kind: 'remove', id: `ghost-${seed}-${step}` });
      }
      const before = store.version;
      try {
        store.commit(ops);
        assert.ok(before !== store.version || ops.length === 0);
      } catch {
        rejected++;
        assert.equal(store.version, before, 'rejected batch must leave the store untouched');
        assert.ok(snapshot(store.version) !== undefined);
      }
    }
  }
  assert.ok(rejected > 0, 'expected some corrupted batches to be rejected');
  console.log(`property test: ${rejected} corrupted batches rejected atomically`);
});
