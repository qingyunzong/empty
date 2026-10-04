import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LiveQuery,
  evaluate,
  type BatchOp,
  type Delta,
  type QuerySpec,
  type ResultEntry,
  type Row,
} from "../src/index.js";

const allRows: QuerySpec = { filter: () => true, k: 3 };

function row(id: string, key: string, value: number, attrs?: Row["attrs"]): Row {
  return attrs === undefined ? { id, key, value } : { id, key, value, attrs };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("过滤 + 按键求和 + 排序前 k，同分按键升序", () => {
  const rows: Row[] = [
    row("1", "b", 5),
    row("2", "a", 3),
    row("3", "b", 5),
    row("4", "c", 10),
    row("5", "d", 10),
    row("6", "e", 10, { drop: true }),
  ];
  const spec: QuerySpec = {
    filter: (r) => r.attrs?.drop !== true,
    k: 3,
  };
  assert.deepEqual(evaluate(rows, spec), [
    { key: "b", sum: 10 },
    { key: "c", sum: 10 },
    { key: "d", sum: 10 },
  ]);
  const spec2: QuerySpec = { filter: () => true, k: 2 };
  assert.deepEqual(evaluate(rows, spec2), [
    { key: "b", sum: 10 },
    { key: "c", sum: 10 },
  ]);
});

test("批更新只发布旧新结果净差", () => {
  const q = new LiveQuery({ filter: () => true, k: 2 });
  q.applyBatch([
    { type: "upsert", row: row("1", "a", 10) },
    { type: "upsert", row: row("2", "b", 8) },
    { type: "upsert", row: row("3", "c", 1) },
  ]);
  assert.deepEqual(q.read(), [
    { key: "a", sum: 10 },
    { key: "b", sum: 8 },
  ]);

  const deltas: Delta[] = [];
  q.onDelta((d) => deltas.push(d));

  const d1 = q.applyBatch([{ type: "upsert", row: row("4", "d", 0) }]);
  assert.deepEqual(d1.changes, []);
  assert.equal(deltas.length, 1);

  const d2 = q.applyBatch([{ type: "upsert", row: row("5", "c", 9) }]);
  assert.deepEqual(d2.changes, [
    { key: "b", oldSum: 8, newSum: null },
    { key: "c", oldSum: null, newSum: 10 },
  ]);
  assert.deepEqual(q.read(), [
    { key: "a", sum: 10 },
    { key: "c", sum: 10 },
  ]);

  const d3 = q.applyBatch([{ type: "upsert", row: row("1", "a", 12) }]);
  assert.deepEqual(d3.changes, [{ key: "a", oldSum: 10, newSum: 12 }]);
});

test("删除行使分组和减少或消失", () => {
  const q = new LiveQuery({ filter: () => true, k: 5 });
  q.applyBatch([
    { type: "upsert", row: row("1", "a", 4) },
    { type: "upsert", row: row("2", "a", 6) },
    { type: "upsert", row: row("3", "b", 7) },
  ]);
  const d1 = q.applyBatch([{ type: "delete", id: "2" }]);
  assert.deepEqual(d1.changes, [{ key: "a", oldSum: 10, newSum: 4 }]);
  const d2 = q.applyBatch([{ type: "delete", id: "1" }]);
  assert.deepEqual(d2.changes, [{ key: "a", oldSum: 4, newSum: null }]);
  assert.deepEqual(q.read(), [{ key: "b", sum: 7 }]);
  const d3 = q.applyBatch([{ type: "delete", id: "missing" }]);
  assert.deepEqual(d3.changes, []);
});

test("订阅者读取固定版本，释放后旧版本被回收", () => {
  const q = new LiveQuery({ filter: () => true, k: 2 });
  q.applyBatch([{ type: "upsert", row: row("1", "a", 1) }]);
  const sub = q.pin();
  assert.equal(sub.version, 2);

  q.applyBatch([{ type: "upsert", row: row("2", "b", 9) }]);
  q.applyBatch([{ type: "upsert", row: row("3", "c", 5) }]);

  assert.deepEqual(sub.read(), [{ key: "a", sum: 1 }]);
  assert.deepEqual(q.read(), [
    { key: "b", sum: 9 },
    { key: "c", sum: 5 },
  ]);
  assert.deepEqual(q.retainedVersions, [2, 4]);

  sub.release();
  q.applyBatch([{ type: "upsert", row: row("4", "d", 7) }]);
  assert.deepEqual(q.retainedVersions, [5]);
  assert.throws(() => q.readAt(2), /not retained/);
  assert.throws(() => sub.read(), /released/);
});

test("条件和参数更改产生新查询代，旧版本快照仍可读", () => {
  const q = new LiveQuery({ filter: () => true, k: 2 });
  q.applyBatch([
    { type: "upsert", row: row("1", "a", 10, { kind: "x" }) },
    { type: "upsert", row: row("2", "b", 8, { kind: "y" }) },
    { type: "upsert", row: row("3", "c", 6, { kind: "x" }) },
  ]);
  assert.equal(q.generation, 1);
  const oldSub = q.pin();

  const delta = q.setQuery({ filter: (r) => r.attrs?.kind === "x", k: 1 });
  assert.equal(delta.generation, 2);
  assert.equal(q.generation, 2);
  assert.deepEqual(delta.changes, [
    { key: "b", oldSum: 8, newSum: null },
  ]);
  assert.deepEqual(q.read(), [{ key: "a", sum: 10 }]);

  assert.deepEqual(oldSub.read(), [
    { key: "a", sum: 10 },
    { key: "b", sum: 8 },
  ]);
  assert.equal(oldSub.generation, 1);

  const d2 = q.applyBatch([{ type: "upsert", row: row("4", "c", 20, { kind: "x" }) }]);
  assert.equal(d2.generation, 2);
  assert.deepEqual(d2.changes, [
    { key: "a", oldSum: 10, newSum: null },
    { key: "c", oldSum: null, newSum: 26 },
  ]);
});

test("每批与全扫描核对：随机批次 + 影子结果重放净差", () => {
  const rand = mulberry32(20261005);
  const filters: Array<(r: Row) => boolean> = [
    () => true,
    (r) => r.value >= 0,
    (r) => r.key <= "f",
  ];
  let spec: QuerySpec = { filter: filters[0]!, k: 3 };
  const q = new LiveQuery(spec);
  const rows = new Map<string, Row>();
  let shadow: ResultEntry[] = [];

  const applyDelta = (delta: Delta) => {
    const map = new Map(shadow.map((e) => [e.key, e.sum]));
    for (const c of delta.changes) {
      if (c.newSum === null) map.delete(c.key);
      else map.set(c.key, c.newSum);
    }
    shadow = [...map.entries()]
      .map(([key, sum]) => ({ key, sum }))
      .sort((a, b) => b.sum - a.sum || (a.key < b.key ? -1 : 1));
  };

  const batches = 300;
  for (let batch = 0; batch < batches; batch++) {
    if (batch % 17 === 16) {
      spec = {
        filter: filters[Math.floor(rand() * filters.length)]!,
        k: Math.floor(rand() * 6),
      };
      applyDelta(q.setQuery(spec));
    }
    const ops: BatchOp[] = [];
    const opCount = Math.floor(rand() * 12);
    for (let i = 0; i < opCount; i++) {
      const id = `r${Math.floor(rand() * 60)}`;
      if (rand() < 0.25) {
        ops.push({ type: "delete", id });
        rows.delete(id);
      } else {
        const r = row(
          id,
          String.fromCharCode(97 + Math.floor(rand() * 10)),
          Math.floor(rand() * 21) - 5,
        );
        ops.push({ type: "upsert", row: r });
        rows.set(id, r);
      }
    }
    const delta = q.applyBatch(ops);
    applyDelta(delta);
    assert.equal(delta.version, q.version);
    assert.deepEqual(
      shadow,
      q.read(),
      `delta replay diverged at version ${q.version}`,
    );
  }

  assert.equal(q.reconcileChecks, batches + Math.floor((batches - 1) / 17));
  assert.deepEqual(q.read(), evaluate(rows.values(), spec));
});

test("边界：k=0、空表、负值、同分截断确定", () => {
  const q0 = new LiveQuery({ filter: () => true, k: 0 });
  q0.applyBatch([{ type: "upsert", row: row("1", "a", 5) }]);
  assert.deepEqual(q0.read(), []);

  const qEmpty = new LiveQuery(allRows);
  assert.deepEqual(qEmpty.read(), []);
  const d = qEmpty.applyBatch([]);
  assert.deepEqual(d.changes, []);

  const qNeg = new LiveQuery({ filter: () => true, k: 3 });
  qNeg.applyBatch([
    { type: "upsert", row: row("1", "a", -3) },
    { type: "upsert", row: row("2", "b", -1) },
    { type: "upsert", row: row("3", "c", 0) },
  ]);
  assert.deepEqual(qNeg.read(), [
    { key: "c", sum: 0 },
    { key: "b", sum: -1 },
    { key: "a", sum: -3 },
  ]);

  const qTie = new LiveQuery({ filter: () => true, k: 2 });
  qTie.applyBatch([
    { type: "upsert", row: row("1", "z", 5) },
    { type: "upsert", row: row("2", "m", 5) },
    { type: "upsert", row: row("3", "a", 5) },
  ]);
  assert.deepEqual(qTie.read(), [
    { key: "a", sum: 5 },
    { key: "m", sum: 5 },
  ]);
});
