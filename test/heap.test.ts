import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { MinHeap } from "../src/heap";

test("pops in (priority, seq) order, ties broken by insertion order", () => {
  const heap = MinHeap.empty<string>();
  heap.push({ priority: 5, seq: 0, value: "a" });
  heap.push({ priority: 3, seq: 1, value: "b" });
  heap.push({ priority: 3, seq: 2, value: "c" });
  heap.push({ priority: 3, seq: 3, value: "d" });
  heap.push({ priority: 1, seq: 4, value: "e" });
  const order: Array<string> = [];
  let entry;
  while ((entry = heap.pop()) !== undefined) order.push(entry.value);
  deepEqual(order, ["e", "b", "c", "d", "a"]);
});

test("snapshot round-trip preserves the exact pop sequence", () => {
  const heap = MinHeap.empty<number>();
  for (let i = 0; i < 50; i++) {
    heap.push({ priority: (i * 37) % 11, seq: i, value: i });
  }
  heap.pop();
  heap.pop();
  const saved = JSON.parse(JSON.stringify(heap.toArray()));
  const expected: Array<number> = [];
  let entry;
  while ((entry = heap.pop()) !== undefined) expected.push(entry.value);

  const restored = MinHeap.fromArray<number>(saved);
  const actual: Array<number> = [];
  while ((entry = restored.pop()) !== undefined) actual.push(entry.value);
  deepEqual(actual, expected);
});

test("fromArray isolates the heap from later pushes to the source", () => {
  const heap = MinHeap.empty<number>();
  heap.push({ priority: 1, seq: 0, value: 1 });
  const saved = heap.toArray();
  heap.push({ priority: 0, seq: 1, value: 2 });
  const restored = MinHeap.fromArray<number>(saved);
  equal(restored.size, 1);
  equal(restored.pop()!.value, 1);
});
