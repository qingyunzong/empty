import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  compare,
  dominates,
  format,
  increment,
  merge,
  type VersionVector,
} from "../src/versionVector";
import { mulberry32, pickInt } from "../src/random";

test("increment 只推进本节点分量", () => {
  const vv = increment({ A: 1 }, "A");
  deepEqual(vv, { A: 2 });
  deepEqual(increment(vv, "B"), { A: 2, B: 1 });
});

test("compare 判定支配/被支配/并发/等价", () => {
  equal(compare({ A: 2 }, { A: 1 }), "dominates");
  equal(compare({ A: 1 }, { A: 2 }), "dominated");
  equal(compare({ A: 1 }, { A: 1 }), "equal");
  equal(compare({ A: 1 }, { B: 1 }), "concurrent");
  equal(compare({ A: 2, B: 1 }, { A: 1, B: 1 }), "dominates");
  equal(compare({ A: 2, B: 1 }, { A: 1, B: 2 }), "concurrent");
});

test("merge 取分量最大值且幂等", () => {
  deepEqual(merge({ A: 2, B: 1 }, { A: 1, C: 3 }), { A: 2, B: 1, C: 3 });
  const vv = { A: 2, B: 1 };
  deepEqual(merge(vv, vv), vv);
});

test("随机向量: compare 与 merge/dominates 一致", () => {
  const rng = mulberry32(42);
  const nodes = ["A", "B", "C"];
  const randomVv = (): VersionVector => {
    const vv: Record<string, number> = {};
    for (const node of nodes) {
      if (rng() < 0.7) vv[node] = pickInt(rng, 1, 5);
    }
    return vv;
  };
  for (let i = 0; i < 500; i++) {
    const a = randomVv();
    const b = randomVv();
    const order = compare(a, b);
    const flipped = compare(b, a);
    if (order === "dominates") equal(flipped, "dominated");
    if (order === "dominated") equal(flipped, "dominates");
    if (order === "equal") equal(flipped, "equal");
    if (order === "concurrent") equal(flipped, "concurrent");
    const merged = merge(a, b);
    ok(dominates(merged, a) || compare(merged, a) === "equal");
    ok(dominates(merged, b) || compare(merged, b) === "equal");
    deepEqual(merge(a, b), merge(b, a));
    if (order === "dominates") deepEqual(merged, a);
  }
});

test("format 输出稳定有序", () => {
  equal(format({ B: 1, A: 2, C: 0 }), "{A:2,B:1}");
  equal(format({}), "{}");
});
