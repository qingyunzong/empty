import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPivot,
  encodePart,
  formatPivot,
  reconcile,
  toBigInt,
  PivotStore,
  type ColNode,
  type PivotEvent,
  type RowNode,
} from "../src/index";

const EP = encodePart;

function* walkRows(node: RowNode): Generator<RowNode> {
  yield node;
  for (const child of node.children.values()) yield* walkRows(child);
}

function* walkCols(node: ColNode): Generator<ColNode> {
  yield node;
  for (const child of node.children.values()) yield* walkCols(child);
}

test("multi-level row/column aggregation with grand total", () => {
  const store = new PivotStore();
  store.ingestAll([
    { kind: "insert", id: "e1", row: ["CN", "BJ"], col: ["2026", "Q1"], value: 10 },
    { kind: "insert", id: "e2", row: ["CN", "BJ"], col: ["2026", "Q2"], value: 20 },
    { kind: "insert", id: "e3", row: ["CN", "SH"], col: ["2026", "Q1"], value: 5 },
    { kind: "insert", id: "e4", row: ["US", "NY"], col: ["2026", "Q1"], value: 7 },
  ]);
  const pivot = buildPivot(store);
  assert.equal(pivot.grandTotal, 42n);
  assert.equal(pivot.grandCount, 4);

  const cn = pivot.root.children.get(EP("CN"));
  assert.ok(cn);
  assert.equal(cn.colRoot.sum, 35n); // row subtotal across all columns
  const bj = cn.children.get(EP("BJ"));
  assert.ok(bj);
  assert.equal(bj.colRoot.sum, 30n);
  const y2026 = bj.colRoot.children.get(EP("2026"));
  assert.ok(y2026);
  assert.equal(y2026.sum, 30n); // column subtotal within row [CN, BJ]
  assert.equal(y2026.children.get(EP("Q1"))?.sum, 10n);
  assert.equal(y2026.children.get(EP("Q2"))?.sum, 20n);
});

test("NULL is its own category, distinct from 'null', 0 and missing levels", () => {
  const store = new PivotStore();
  store.ingestAll([
    { kind: "insert", id: "n1", row: [null], col: ["X"], value: 1 },
    { kind: "insert", id: "n2", row: ["null"], col: ["X"], value: 2 },
    { kind: "insert", id: "n3", row: [0], col: ["X"], value: 4 },
    { kind: "insert", id: "n4", row: [], col: ["X"], value: 8 },
    { kind: "insert", id: "n5", row: [null], col: [null], value: 16 },
  ]);
  const pivot = buildPivot(store);
  assert.equal(pivot.grandTotal, 31n);
  // Three distinct first-level row categories; the empty row key []
  // has no first level and rolls straight into the grand total.
  assert.equal(pivot.root.children.size, 3);
  assert.equal(pivot.root.children.get(EP(null))?.colRoot.sum, 17n); // [null] rows: 1 + 16
  assert.equal(pivot.root.children.get(EP("null"))?.colRoot.sum, 2n);
  assert.equal(pivot.root.children.get(EP(0))?.colRoot.sum, 4n);
  // The [null] row keeps its NULL column separate from column "X".
  const nullRow = pivot.root.children.get(EP(null));
  assert.ok(nullRow);
  assert.equal(nullRow.colRoot.children.get(EP(null))?.sum, 16n);
  assert.equal(nullRow.colRoot.children.get(EP("X"))?.sum, 1n);
  assert.ok(reconcile(store, pivot).ok);
});

test("subtotals equal the sum of their children at every level (no double count)", () => {
  const store = new PivotStore();
  const events: PivotEvent[] = [];
  let id = 0;
  for (const a of ["A", "B", null] as const) {
    for (const b of ["x", "y"] as const) {
      for (const c of ["P", null] as const) {
        events.push({ kind: "insert", id: `s${id}`, row: [a, b], col: [c], value: id + 1 });
        id += 1;
      }
    }
  }
  store.ingestAll(events);
  const pivot = buildPivot(store);
  // Parent subtotal == sum of child subtotals, row-wise and column-wise.
  for (const row of walkRows(pivot.root)) {
    if (row.children.size > 0) {
      let childSum = 0n;
      for (const child of row.children.values()) childSum += child.colRoot.sum;
      assert.equal(row.colRoot.sum, childSum);
    }
    for (const col of walkCols(row.colRoot)) {
      if (col.children.size > 0) {
        let childSum = 0n;
        for (const child of col.children.values()) childSum += child.sum;
        assert.equal(col.sum, childSum);
      }
    }
  }
  // Leaf-level sums add up to the grand total exactly once each.
  let leafSum = 0n;
  for (const leaf of store.leaves().values()) leafSum += leaf.sum;
  assert.equal(pivot.grandTotal, leafSum);
  assert.ok(reconcile(store, pivot).ok);
});

test("exact integers beyond 2^53; unsafe numbers rejected", () => {
  const store = new PivotStore();
  store.ingestAll([
    { kind: "insert", id: "b1", row: ["A"], col: ["X"], value: 9007199254740993n },
    { kind: "insert", id: "b2", row: ["A"], col: ["X"], value: "9007199254740993" },
    { kind: "insert", id: "b3", row: ["A"], col: ["X"], value: 7 },
  ]);
  const pivot = buildPivot(store);
  assert.equal(pivot.grandTotal, 18014398509481993n); // exact, not rounded
  assert.throws(() => toBigInt(9007199254740993), /safe integer/);
  assert.throws(() => toBigInt(1.5), /safe integer/);
  assert.throws(() => toBigInt("12.5"), /integer literal/);
});

test("corrections carry event ids and are idempotent", () => {
  const store = new PivotStore();
  store.ingest({ kind: "insert", id: "r1", row: ["A"], col: ["X"], value: 100 });
  const dup = store.ingest({ kind: "insert", id: "r1", row: ["A"], col: ["X"], value: 100 });
  assert.deepEqual(dup, { applied: false, reason: "duplicate-event-id" });

  assert.ok(store.ingest({ kind: "adjust", id: "c1", target: "r1", delta: -30 }).applied);
  const dupAdjust = store.ingest({ kind: "adjust", id: "c1", target: "r1", delta: -30 });
  assert.deepEqual(dupAdjust, { applied: false, reason: "duplicate-event-id" });

  assert.deepEqual(store.ingest({ kind: "adjust", id: "c2", target: "nope", delta: 1 }), {
    applied: false,
    reason: "unknown-target",
  });

  const pivot = buildPivot(store);
  assert.equal(pivot.grandTotal, 70n); // 100 - 30, correction applied exactly once
  assert.ok(reconcile(store, pivot).ok);
});

test("cross-group migration moves value, empties source group, conserves total", () => {
  const store = new PivotStore();
  store.ingestAll([
    { kind: "insert", id: "m1", row: ["A"], col: ["X"], value: 40 },
    { kind: "insert", id: "m2", row: ["A"], col: ["X"], value: 2 },
    { kind: "insert", id: "m3", row: ["B"], col: ["Y"], value: 8 },
  ]);
  const before = buildPivot(store).grandTotal;

  // Migrate m1 from [A]x[X] to [B]x[Y]; replaying the same event id is a no-op.
  assert.ok(store.ingest({ kind: "move", id: "mv1", target: "m1", row: ["B"], col: ["Y"] }).applied);
  assert.deepEqual(store.ingest({ kind: "move", id: "mv1", target: "m1", row: ["B"], col: ["Y"] }), {
    applied: false,
    reason: "duplicate-event-id",
  });

  const pivot = buildPivot(store);
  assert.equal(pivot.grandTotal, before); // migration conserves the grand total
  assert.equal(pivot.root.children.get(EP("A"))?.colRoot.sum, 2n); // only m2 left
  assert.equal(pivot.root.children.get(EP("B"))?.colRoot.sum, 48n); // 8 + 40 arrived
  assert.ok(reconcile(store, pivot).ok);

  // Migrate m2 away too: group [A]x[X] becomes empty and disappears.
  store.ingest({ kind: "move", id: "mv2", target: "m2", row: ["B"], col: ["Y"] });
  const after = buildPivot(store);
  assert.equal(after.root.children.size, 1); // only [B] remains
  assert.equal(after.grandTotal, before);
  const report = reconcile(store, after);
  assert.ok(report.ok);
  assert.equal(report.staleInPivot.length, 0); // no stale empty groups
});

test("zero-sum group with live records is kept; empty group is dropped", () => {
  const store = new PivotStore();
  store.ingestAll([
    { kind: "insert", id: "z1", row: ["Z"], col: ["X"], value: 5 },
    { kind: "insert", id: "z2", row: ["Z"], col: ["X"], value: -5 },
  ]);
  const leafId = PivotStore.leafId(["Z"], ["X"]);
  const leaf = store.leaves().get(leafId);
  assert.ok(leaf, "zero-sum group with records must stay");
  assert.equal(leaf.sum, 0n);
  assert.equal(leaf.count, 2);

  store.ingest({ kind: "move", id: "mz1", target: "z1", row: ["W"] });
  store.ingest({ kind: "move", id: "mz2", target: "z2", row: ["W"] });
  assert.equal(store.leaves().has(leafId), false, "emptied group must be dropped");
  assert.ok(reconcile(store).ok);
});

test("reconciliation holds for a randomized event stream", () => {
  // Deterministic PRNG so failures are reproducible.
  let state = 0x2f6e2b1;
  const rand = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

  const rowParts = ["CN", "US", null, "BJ", "SH", "NY", 7] as const;
  const colParts = ["2026", "Q1", "Q2", null] as const;
  const store = new PivotStore();
  const insertIds: string[] = [];
  let expectedTotal = 0n;
  let seq = 0;
  const nextId = (): string => `ev${seq++}`;

  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 25; i++) {
      const kind = rand();
      if (kind < 0.5 || insertIds.length === 0) {
        const value = BigInt(Math.floor(rand() * 2000) - 1000) * 9007199254740993n;
        const id = nextId();
        store.ingest({
          kind: "insert",
          id,
          row: [pick(rowParts), pick(rowParts)],
          col: [pick(colParts)],
          value,
        });
        insertIds.push(id);
        expectedTotal += value;
      } else if (kind < 0.75) {
        const delta = BigInt(Math.floor(rand() * 200) - 100);
        store.ingest({ kind: "adjust", id: nextId(), target: pick(insertIds), delta });
        expectedTotal += delta;
      } else {
        store.ingest({
          kind: "move",
          id: nextId(),
          target: pick(insertIds),
          row: [pick(rowParts), pick(rowParts)],
          col: [pick(colParts)],
        });
      }
      // ~10% duplicate-id replays must all be rejected.
      if (rand() < 0.1 && seq > 0) {
        const replay = `ev${Math.floor(rand() * seq)}`;
        const result = store.ingest({ kind: "adjust", id: replay, target: "ev0", delta: 1 });
        if (result.applied) expectedTotal += 1n; // id was fresh after all
      }
    }
    const report = reconcile(store);
    assert.ok(
      report.ok,
      `round ${round}: missing=${report.missingInPivot.length} stale=${report.staleInPivot.length} ` +
        `groups=${report.groupMismatches.length} cells=${report.cellMismatches.length}`,
    );
    assert.equal(report.grandTotalPivot, expectedTotal);
    assert.equal(report.grandTotalReference, expectedTotal);
  }
});

test("tree rendering shows row/column levels and the grand total", () => {
  const store = new PivotStore();
  store.ingestAll([
    { kind: "insert", id: "f1", row: ["CN", "BJ"], col: ["Q1"], value: 3 },
    { kind: "insert", id: "f2", row: ["CN", null], col: [null], value: 4 },
  ]);
  const text = formatPivot(buildPivot(store));
  const lines = text.split("\n");
  assert.ok(lines.some((l) => l.includes('row ["CN"]') && l.includes("sum=7")));
  assert.ok(lines.some((l) => l.includes('row ["CN" / "BJ"]') && l.includes("sum=3")));
  assert.ok(lines.some((l) => l.includes('row ["CN" / NULL]') && l.includes("sum=4")));
  assert.ok(lines.some((l) => l.includes('col ["Q1"]') && l.includes("sum=3")));
  assert.ok(lines.some((l) => l.includes("col [NULL]") && l.includes("sum=4")));
  assert.equal(lines.at(-1), "TOTAL  sum=7  n=2");
});
