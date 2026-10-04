import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertWindowStore } from "../src/store.js";
import { displayBySortedScan } from "../src/reference.js";
import { mulberry32, shuffle } from "../src/prng.js";
import { compareEvents } from "../src/types.js";
import type { AlertEvent } from "../src/types.js";
import { displaySignature } from "../src/executor.js";

test("每个 key 只显示窗口内最早事件，同刻按 ID 决胜", () => {
  const store = new AlertWindowStore({ start: 100, end: 200 });
  store.upsert({ id: "c", key: "cpu", time: 150 });
  store.upsert({ id: "b", key: "cpu", time: 120 });
  store.upsert({ id: "d", key: "cpu", time: 180 });
  assert.deepEqual(store.display().map((e) => e.id), ["b"]);

  // Same timestamp: the lexicographically smaller id wins.
  store.upsert({ id: "a", key: "cpu", time: 120 });
  assert.deepEqual(store.display().map((e) => e.id), ["a"]);

  // A different key is displayed independently.
  store.upsert({ id: "m1", key: "mem", time: 199 });
  assert.deepEqual(store.display().map((e) => e.id), ["a", "m1"]);
});

test("窗口左端包含、右端不包含", () => {
  const store = new AlertWindowStore({ start: 100, end: 200 });
  store.upsert({ id: "at-start", key: "k1", time: 100 });
  store.upsert({ id: "at-end", key: "k2", time: 200 });
  store.upsert({ id: "before", key: "k3", time: 99 });
  assert.deepEqual(store.display().map((e) => e.id), ["at-start"]);

  const batch = store.moveWindow(200, 300);
  assert.equal(batch!.source, "window");
  assert.deepEqual(store.display().map((e) => e.id), ["at-end"]);
});

test("删除最早事件后次早事件接替显示", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  store.upsert({ id: "e1", key: "k", time: 10 });
  store.upsert({ id: "e2", key: "k", time: 20 });
  store.upsert({ id: "e3", key: "k", time: 30 });
  assert.deepEqual(store.display().map((e) => e.id), ["e1"]);

  const b1 = store.remove("e1")!;
  assert.equal(b1.source, "remove");
  assert.deepEqual(
    b1.changes.map((c) => `${c.type}:${c.event.id}`),
    ["removed:e1", "added:e2"],
  );
  assert.deepEqual(store.display().map((e) => e.id), ["e2"]);

  store.remove("e2");
  assert.deepEqual(store.display().map((e) => e.id), ["e3"]);

  const b3 = store.remove("e3")!;
  assert.deepEqual(b3.changes.map((c) => `${c.type}:${c.event.id}`), ["removed:e3"]);
  assert.deepEqual(store.display(), []);
});

test("插入更早事件会取代当前显示，更晚事件不影响显示", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  store.upsert({ id: "e2", key: "k", time: 20 });
  const noop = store.upsert({ id: "e9", key: "k", time: 90 })!;
  assert.deepEqual(noop.changes, []);

  const displace = store.upsert({ id: "e1", key: "k", time: 10 })!;
  assert.deepEqual(
    displace.changes.map((c) => `${c.type}:${c.event.id}`),
    ["removed:e2", "added:e1"],
  );
  assert.deepEqual(store.display().map((e) => e.id), ["e1"]);
});

test("移动窗口输出显示集增删，版本连续且来源正确", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  store.upsert({ id: "a", key: "k1", time: 50 }); // v1
  store.upsert({ id: "b", key: "k2", time: 150 }); // v2
  store.upsert({ id: "c", key: "k3", time: 250 }); // v3
  assert.equal(store.currentVersion, 3);

  const batch = store.moveWindow(100, 300)!; // v4
  assert.equal(batch.version, 4);
  assert.equal(batch.source, "window");
  assert.deepEqual(
    batch.changes.map((c) => `${c.type}:${c.event.id}`),
    ["removed:a", "added:b", "added:c"],
  );
  assert.deepEqual(store.display().map((e) => e.id), ["b", "c"]);
});

test("随机乱序插入与全排序扫描结果一致", () => {
  const rng = mulberry32(42);
  const events: AlertEvent[] = [];
  for (let i = 0; i < 300; i++) {
    events.push({ id: `e${i}`, key: `k${i % 7}`, time: Math.floor(rng() * 1000) });
  }
  const win = { start: 200, end: 800 };

  const shuffled = shuffle(events, mulberry32(7));
  const sorted = [...events].sort(compareEvents);

  const fromShuffled = new AlertWindowStore(win);
  for (const e of shuffled) fromShuffled.upsert(e);

  const fromSorted = new AlertWindowStore(win);
  for (const e of sorted) fromSorted.upsert(e);

  const expected = displayBySortedScan(events, win.start, win.end);
  assert.deepEqual(displaySignature(fromShuffled.displayedMap()), displaySignature(expected));
  assert.deepEqual(displaySignature(fromSorted.displayedMap()), displaySignature(expected));
  assert.equal(fromShuffled.currentVersion, fromSorted.currentVersion);
});

test("同事务内的增删被净额结算，不含已被撤销的显示项", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  store.upsert({ id: "base", key: "k", time: 10 }); // v1

  const batch = store.transaction(() => {
    store.upsert({ id: "tmp", key: "k2", time: 20 });
    store.remove("tmp");
  });
  assert.equal(batch.version, 2);
  assert.equal(batch.source, "transaction");
  assert.deepEqual(batch.changes, []);

  // Remove + re-insert of the same event inside one batch also nets out.
  const batch2 = store.transaction(() => {
    store.remove("base");
    store.upsert({ id: "base", key: "k", time: 10 });
  });
  assert.equal(batch2.version, 3);
  assert.deepEqual(batch2.changes, []);
  assert.deepEqual(store.display().map((e) => e.id), ["base"]);
});

test("窗口参数非法时抛错", () => {
  assert.throws(() => new AlertWindowStore({ start: 10, end: 5 }));
  const store = new AlertWindowStore({ start: 0, end: 100 });
  assert.throws(() => store.moveWindow(50, 40));
});
