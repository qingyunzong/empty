import { test } from "node:test";
import * as assert from "node:assert";
import { MinHeap } from "../src/heap.js";
import { mulberry32 } from "./util.js";

test("min-heap pops in non-decreasing order", () => {
  const rnd = mulberry32(42);
  const h = new MinHeap<number>((a, b) => a - b);
  const xs: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const x = Math.floor(rnd() * 10000);
    xs.push(x);
    h.push(x);
  }
  const out: number[] = [];
  while (h.size > 0) out.push(h.pop()!);
  assert.deepStrictEqual(out, [...xs].sort((a, b) => a - b));
});

test("empty heap pops undefined; snapshotSorted does not mutate", () => {
  const h = new MinHeap<number>((a, b) => a - b);
  assert.strictEqual(h.pop(), undefined);
  h.push(3);
  h.push(1);
  h.push(2);
  assert.deepStrictEqual(h.snapshotSorted(), [1, 2, 3]);
  assert.strictEqual(h.size, 3);
  assert.strictEqual(h.peek(), 1);
});
