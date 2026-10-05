import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MergeStore,
  diffSnapshots,
  snapshotOf,
  type FieldView,
  type NetDiff,
  type Snapshot,
  type TransformStep,
} from "../src/merge.js";

const trim: TransformStep = {
  name: "trim",
  apply: (v) => (typeof v === "string" ? v.trim() : v),
};
const lower: TransformStep = {
  name: "lower",
  apply: (v) => (typeof v === "string" ? v.toLowerCase() : v),
};

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

function snapshotMap(view: Record<string, FieldView>): Map<string, Snapshot> {
  const out = new Map<string, Snapshot>();
  for (const [field, fv] of Object.entries(view)) out.set(field, snapshotOf(fv));
  return out;
}

function applyDiff(view: Record<string, Snapshot>, diff: NetDiff): Record<string, Snapshot> {
  const next = { ...view };
  for (const change of diff) {
    if (change.to.status === "absent") delete next[change.field];
    else next[change.field] = change.to;
  }
  return next;
}

function snapshotsObject(view: Record<string, FieldView>): Record<string, Snapshot> {
  return Object.fromEntries(snapshotMap(view));
}

test("same value from multiple sources merges with full provenance", () => {
  const store = new MergeStore();
  store.apply("srcA", 1, { name: "alice" });
  store.apply("srcB", 3, { name: "alice" });
  const view = store.get("name");
  assert.ok(view);
  assert.equal(view.status, "resolved");
  assert.equal(view.value, "alice");
  assert.deepEqual(
    view.sources.map((c) => ({ source: c.source, version: c.version, chain: c.chain })),
    [
      { source: "srcA", version: 1, chain: [] },
      { source: "srcB", version: 3, chain: [] },
    ],
  );
});

test("different values produce a conflict with per-value sources", () => {
  const store = new MergeStore();
  store.apply("srcA", 1, { age: 30 });
  store.apply("srcB", 2, { age: 31 });
  const view = store.get("age");
  assert.ok(view);
  assert.equal(view.status, "conflict");
  assert.equal(view.value, undefined);
  assert.deepEqual(
    view.values.map((g) => ({
      value: g.value,
      sources: g.contributions.map((c) => c.source),
    })),
    [
      { value: 30, sources: ["srcA"] },
      { value: 31, sources: ["srcB"] },
    ],
  );
});

test("retract removes only the retracted source's contribution", () => {
  const store = new MergeStore();
  store.apply("srcA", 1, { name: "alice" });
  store.apply("srcB", 2, { name: "alice" });
  const diff = store.retract("srcA");
  assert.deepEqual(diff, []);
  const view = store.get("name");
  assert.ok(view);
  assert.equal(view.status, "resolved");
  assert.equal(view.value, "alice");
  assert.deepEqual(
    view.sources.map((c) => c.source),
    ["srcB"],
  );
});

test("field disappears when its last source is retracted", () => {
  const store = new MergeStore();
  store.apply("srcA", 1, { name: "alice", nick: "al" });
  store.apply("srcB", 1, { name: "alice" });
  const diff = store.retract("srcA");
  assert.equal(store.get("nick"), undefined);
  assert.deepEqual(diff, [
    { field: "nick", from: { status: "resolved", value: "al" }, to: { status: "absent" } },
  ]);
  assert.equal(store.get("name")?.status, "resolved");
});

test("retracting one side of a conflict resolves the field", () => {
  const store = new MergeStore();
  store.apply("srcA", 1, { age: 30 });
  store.apply("srcB", 1, { age: 31 });
  const diff = store.retract("srcB");
  assert.deepEqual(diff, [
    {
      field: "age",
      from: { status: "conflict", values: [30, 31] },
      to: { status: "resolved", value: 30 },
    },
  ]);
});

test("transform chain is recorded and normalizes values into a merge", () => {
  const store = new MergeStore();
  store.apply("srcA", 1, { name: "  Alice " });
  store.apply("srcB", 4, { name: "ALICE" }, [trim, lower]);
  const view = store.get("name");
  assert.ok(view);
  assert.equal(view.status, "conflict");
  store.retract("srcA");
  const after = store.get("name");
  assert.ok(after);
  assert.equal(after.status, "resolved");
  assert.equal(after.value, "alice");
  const contrib = after.sources[0];
  assert.ok(contrib);
  assert.deepEqual(contrib.chain, ["trim", "lower"]);
  assert.equal(contrib.raw, "ALICE");
  assert.equal(contrib.version, 4);
});

test("same transform chain on both sides merges raw-different values", () => {
  const store = new MergeStore();
  store.apply("srcA", 1, { name: " Bob " }, [trim, lower]);
  store.apply("srcB", 1, { name: "BOB" }, [trim, lower]);
  const view = store.get("name");
  assert.ok(view);
  assert.equal(view.status, "resolved");
  assert.equal(view.value, "bob");
  assert.equal(view.sources.length, 2);
});

test("re-applying a source with a new version replaces its contributions", () => {
  const store = new MergeStore();
  store.apply("srcA", 1, { age: 30 });
  store.apply("srcB", 1, { age: 30 });
  const diff = store.apply("srcA", 2, { age: 31 });
  assert.deepEqual(diff, [
    {
      field: "age",
      from: { status: "resolved", value: 30 },
      to: { status: "conflict", values: [30, 31] },
    },
  ]);
  const view = store.get("age");
  assert.ok(view);
  assert.deepEqual(
    view.sources.map((c) => ({ source: c.source, version: c.version })),
    [
      { source: "srcA", version: 2 },
      { source: "srcB", version: 1 },
    ],
  );
  assert.deepEqual(store.sources(), [
    { source: "srcA", version: 2 },
    { source: "srcB", version: 1 },
  ]);
});

test("net diff reports added, changed, removed and conflict transitions", () => {
  const store = new MergeStore();
  const d1 = store.apply("srcA", 1, { a: 1, b: 2 });
  assert.deepEqual(d1, [
    { field: "a", from: { status: "absent" }, to: { status: "resolved", value: 1 } },
    { field: "b", from: { status: "absent" }, to: { status: "resolved", value: 2 } },
  ]);
  const d2 = store.apply("srcB", 1, { b: 3, c: 9 });
  assert.deepEqual(d2, [
    { field: "b", from: { status: "resolved", value: 2 }, to: { status: "conflict", values: [2, 3] } },
    { field: "c", from: { status: "absent" }, to: { status: "resolved", value: 9 } },
  ]);
  const d3 = store.retract("srcB");
  assert.deepEqual(d3, [
    { field: "b", from: { status: "conflict", values: [2, 3] }, to: { status: "resolved", value: 2 } },
    { field: "c", from: { status: "resolved", value: 9 }, to: { status: "absent" } },
  ]);
});

test("random retractions match full rebuild from remaining sources", () => {
  const fields = ["a", "b", "c", "d", "e"];
  const valuePool: unknown[] = [1, 2, 3, "x", "y", true, null];
  const chains: TransformStep[][] = [[], [trim], [trim, lower]];

  for (let seed = 1; seed <= 40; seed++) {
    const rng = mulberry32(seed);
    const inputs: { id: string; version: number; record: Record<string, unknown>; chain: TransformStep[] }[] = [];
    const sourceCount = 8;
    for (let i = 0; i < sourceCount; i++) {
      const record: Record<string, unknown> = {};
      for (const field of fields) {
        if (rng() < 0.6) {
          const picked = valuePool[Math.floor(rng() * valuePool.length)];
          record[field] = picked;
        }
      }
      const chain = chains[Math.floor(rng() * chains.length)] as TransformStep[];
      inputs.push({ id: `s${i}`, version: 1 + Math.floor(rng() * 3), record, chain });
    }

    const store = new MergeStore();
    for (const input of inputs) store.apply(input.id, input.version, input.record, input.chain);

    const remaining = new Map(inputs.map((input) => [input.id, input]));
    const order = [...remaining.keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const a = order[i] as string;
      order[i] = order[j] as string;
      order[j] = a;
    }

    for (const id of order) {
      const beforeView = snapshotsObject(store.view());
      const diff = store.retract(id);
      remaining.delete(id);

      const rebuilt = new MergeStore();
      for (const input of remaining.values()) {
        rebuilt.apply(input.id, input.version, input.record, input.chain);
      }

      assert.deepEqual(
        store.view(),
        rebuilt.view(),
        `seed=${seed} after retracting ${id}: incremental view != rebuild`,
      );

      const afterView = snapshotsObject(store.view());
      assert.deepEqual(
        applyDiff(beforeView, diff),
        afterView,
        `seed=${seed} after retracting ${id}: net diff does not reproduce new view`,
      );
      assert.deepEqual(
        diff,
        diffSnapshots(new Map(Object.entries(beforeView)), snapshotMap(store.view())),
        `seed=${seed} after retracting ${id}: diff inconsistent with snapshot diff`,
      );
    }

    assert.deepEqual(store.view(), {}, `seed=${seed}: store not empty after retracting all`);
  }
});
