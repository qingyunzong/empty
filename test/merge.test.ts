import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MergeStore,
  type FieldView,
  type MergeDiff,
  type MergeOptions,
  type Scalar,
  type SourceInput,
} from "../src/index.js";

type Snapshot = { [field: string]: FieldView };

function applyDiff(snapshot: Snapshot, diff: MergeDiff): Snapshot {
  const next: Snapshot = { ...snapshot };
  for (const change of diff.changes) {
    if (change.after === null) {
      delete next[change.field];
    } else {
      next[change.field] = change.after;
    }
  }
  return next;
}

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

test("same value from multiple sources merges into one value with all provenance", () => {
  const store = new MergeStore();
  store.addSource({ id: "a", version: 1, record: { name: "alice", age: 30 } });
  store.addSource({ id: "b", version: 2, record: { name: "alice" } });

  const name = store.getField("name")!;
  assert.equal(name.status, "value");
  assert.equal(name.value, "alice");
  assert.deepEqual(
    name.sources.map((s) => [s.sourceId, s.sourceVersion]),
    [
      ["a", 1],
      ["b", 2],
    ],
  );

  const age = store.getField("age")!;
  assert.equal(age.sources.length, 1);
});

test("transform chain is recorded per contribution and applied before comparison", () => {
  const store = new MergeStore({
    fieldTransforms: { city: ["trim", "lower"] },
  });
  store.addSource({ id: "a", version: 1, record: { city: "  Berlin " } });
  store.addSource({ id: "b", version: 3, record: { city: "BERLIN" } });

  const city = store.getField("city")!;
  assert.equal(city.status, "value");
  assert.equal(city.value, "berlin");

  const fromA = city.sources.find((s) => s.sourceId === "a")!;
  assert.equal(fromA.raw, "  Berlin ");
  assert.deepEqual(fromA.transforms, ["trim", "lower"]);
  assert.equal(fromA.value, "berlin");

  const fromB = city.sources.find((s) => s.sourceId === "b")!;
  assert.equal(fromB.raw, "BERLIN");
  assert.equal(fromB.value, "berlin");
});

test("different values produce a conflict with all candidates", () => {
  const store = new MergeStore();
  store.addSource({ id: "a", version: 1, record: { score: 10 } });
  store.addSource({ id: "b", version: 1, record: { score: 20 } });
  store.addSource({ id: "c", version: 1, record: { score: 20 } });

  const score = store.getField("score")!;
  assert.equal(score.status, "conflict");
  assert.equal(score.value, undefined);
  assert.deepEqual(
    score.candidates.map((c) => [c.value, c.sources.map((s) => s.sourceId)]),
    [
      [10, ["a"]],
      [20, ["b", "c"]],
    ],
  );
});

test("withdrawing a source removes only its contributions and emits a net diff", () => {
  const store = new MergeStore();
  store.addSource({ id: "a", version: 1, record: { x: 1, shared: "s" } });
  store.addSource({ id: "b", version: 1, record: { x: 2, shared: "s" } });

  const diff = store.withdrawSource("a");

  // x: conflict resolved to b's value; shared: same value, one less source.
  assert.deepEqual(
    diff.changes.map((c) => c.field),
    ["shared", "x"],
  );
  const xChange = diff.changes.find((c) => c.field === "x")!;
  assert.equal(xChange.before!.status, "conflict");
  assert.equal(xChange.after!.status, "value");
  assert.equal(xChange.after!.value, 2);
  assert.deepEqual(
    xChange.after!.sources.map((s) => s.sourceId),
    ["b"],
  );

  const shared = store.getField("shared")!;
  assert.equal(shared.value, "s");
  assert.deepEqual(
    shared.sources.map((s) => s.sourceId),
    ["b"],
  );
});

test("a field disappears once its last source is withdrawn", () => {
  const store = new MergeStore();
  store.addSource({ id: "a", version: 1, record: { only: "here", keep: 1 } });
  store.addSource({ id: "b", version: 1, record: { keep: 1 } });

  const diff = store.withdrawSource("a");
  const only = diff.changes.find((c) => c.field === "only")!;
  assert.equal(only.before!.status, "value");
  assert.equal(only.after, null);
  assert.equal(store.getField("only"), null);
  assert.equal(store.getField("keep")!.value, 1);
});

test("withdrawing an unknown source is a no-op with an empty diff", () => {
  const store = new MergeStore();
  store.addSource({ id: "a", version: 1, record: { x: 1 } });
  const diff = store.withdrawSource("ghost");
  assert.deepEqual(diff.changes, []);
  assert.equal(store.getField("x")!.value, 1);
});

test("re-adding a source with a new version replaces its contributions", () => {
  const store = new MergeStore();
  store.addSource({ id: "a", version: 1, record: { x: 1, stale: true } });
  const diff = store.addSource({ id: "a", version: 2, record: { x: 9 } });

  const x = store.getField("x")!;
  assert.equal(x.value, 9);
  assert.equal(x.sources[0]!.sourceVersion, 2);
  assert.equal(store.getField("stale"), null);
  assert.ok(diff.changes.some((c) => c.field === "stale" && c.after === null));
});

test("net diffs replay exactly onto a shadow snapshot", () => {
  const store = new MergeStore();
  let shadow = store.snapshot();
  const sources: SourceInput[] = [
    { id: "a", version: 1, record: { p: "x", q: 1 } },
    { id: "b", version: 1, record: { p: "x", q: 2, r: null } },
    { id: "c", version: 1, record: { q: 2 } },
  ];
  for (const source of sources) {
    shadow = applyDiff(shadow, store.addSource(source));
    assert.deepEqual(shadow, store.snapshot());
  }
  for (const id of ["b", "a", "c"]) {
    shadow = applyDiff(shadow, store.withdrawSource(id));
    assert.deepEqual(shadow, store.snapshot());
  }
  assert.deepEqual(store.snapshot(), {});
});

test("random withdrawals match a full rebuild from the remaining sources", () => {
  const fieldNames = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"];
  const stringPool = ["alpha", " beta ", "GAMMA", "delta  x", "alpha", "gamma"];
  const numberPool = [1, 2, 2.005, 3.5, 7];
  const transformNames = [[], ["trim"], ["trim", "lower"], ["normalizeSpace"], ["round2"], ["trunc"]];

  for (let trial = 0; trial < 100; trial++) {
    const rng = mulberry32(trial * 1000 + 7);

    const fieldTransforms: { [field: string]: string[] } = {};
    for (const field of fieldNames) {
      if (rng() < 0.7) {
        fieldTransforms[field] = pick(rng, transformNames);
      }
    }
    const options: MergeOptions = { fieldTransforms };

    const sourceCount = 4 + Math.floor(rng() * 5);
    const sources: SourceInput[] = [];
    for (let i = 0; i < sourceCount; i++) {
      const record: { [field: string]: Scalar } = {};
      for (const field of fieldNames) {
        if (rng() < 0.6) {
          record[field] =
            rng() < 0.5 ? pick(rng, stringPool) : pick(rng, numberPool);
        }
      }
      sources.push({ id: `s${i}`, version: 1 + Math.floor(rng() * 3), record });
    }

    const store = new MergeStore(options);
    for (const source of sources) {
      store.addSource(source);
    }
    assert.deepEqual(store.snapshot(), MergeStore.rebuild(sources, options).snapshot());

    let remaining = [...sources];
    let shadow = store.snapshot();
    const order = [...sources];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const source of order) {
      const diff = store.withdrawSource(source.id);
      shadow = applyDiff(shadow, diff);
      remaining = remaining.filter((s) => s.id !== source.id);

      const rebuilt = MergeStore.rebuild(remaining, options);
      assert.deepEqual(
        store.snapshot(),
        rebuilt.snapshot(),
        `trial ${trial}: incremental state diverged after withdrawing ${source.id}`,
      );
      assert.deepEqual(
        shadow,
        store.snapshot(),
        `trial ${trial}: replayed net diffs diverged after withdrawing ${source.id}`,
      );
    }
    assert.deepEqual(store.snapshot(), {});
  }
});
