import { test } from "node:test";
import assert from "node:assert/strict";
import { SequenceLibrary, type LisCertificate } from "../src/sequence-lib.js";

/** 枚举全部下标子集，返回所有最长严格递增子序列的下标组合。 */
function bruteForceAllBest(seq: number[]): number[][] {
  const n = seq.length;
  let bestLen = 0;
  let best: number[][] = [[]]; // 空子集总是长度 0 的可行解
  for (let mask = 0; mask < 1 << n; mask++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    let ok = true;
    for (let k = 1; k < idx.length; k++) {
      if (!(seq[idx[k]] > seq[idx[k - 1]])) { ok = false; break; }
    }
    if (!ok) continue;
    if (idx.length > bestLen) { bestLen = idx.length; best = [idx]; }
    else if (idx.length === bestLen && idx.length > 0) best.push(idx);
  }
  return best;
}

function compareIndexTuple(a: number[], b: number[]): number {
  for (let k = 0; k < Math.min(a.length, b.length); k++) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  return a.length - b.length;
}

/** 枚举对照：长度一致，且证书等于全部最优解中索引字典序最小的唯一解。 */
function assertMatchesBruteForce(seq: number[]): void {
  const lib = new SequenceLibrary();
  for (const v of seq) lib.append(v);
  const cert = lib.lisCertificate();
  const allBest = bruteForceAllBest(seq);
  assert.equal(cert.length, allBest[0]?.length ?? 0, `长度不一致: [${seq}]`);
  const sorted = [...allBest].sort(compareIndexTuple);
  assert.deepEqual(cert.indices, sorted[0], `索引证书不是字典序最小: [${seq}]`);
  // 唯一选择：索引字典序最小解唯一（字典序最小元必然唯一）。
  const minCount = sorted.filter((t) => compareIndexTuple(t, sorted[0]) === 0).length;
  assert.equal(minCount, 1);
  assert.ok(lib.verifyCertificate(cert), `证书校验失败: [${seq}]`);
}

test("append/undo 基本行为", () => {
  const lib = new SequenceLibrary();
  assert.equal(lib.size, 0);
  lib.append(3); lib.append(1); lib.append(4);
  assert.deepEqual(lib.snapshot(), [3, 1, 4]);
  assert.equal(lib.undo(), 4);
  assert.deepEqual(lib.snapshot(), [3, 1]);
  assert.equal(lib.undo(), 1);
  assert.equal(lib.undo(), 3);
  assert.equal(lib.size, 0);
  assert.throws(() => lib.undo(), RangeError);
  assert.throws(() => lib.append(Number.NaN), TypeError);
});

test("undo 后证书与重新构建一致", () => {
  const lib = new SequenceLibrary();
  for (const v of [5, 2, 8, 1, 9, 3]) lib.append(v);
  lib.undo(); // 移除 3
  lib.undo(); // 移除 9
  const fresh = new SequenceLibrary();
  for (const v of [5, 2, 8, 1]) fresh.append(v);
  assert.deepEqual(lib.lisCertificate(), fresh.lisCertificate());
  lib.append(7);
  assertMatchesBruteForce([5, 2, 8, 1, 7]);
  // 候选 [0,2](5,8)、[0,4](5,7)、[1,2](2,8)、[1,4](2,7)、[3,4](1,7)，索引序最小为 [0,2]。
  assert.deepEqual(lib.lisCertificate().indices, [0, 2]);
});

test("等长时按索引序最小，而非值序最小", () => {
  // [2,1,3]：最优长度 2，候选下标 [0,2](值2,3) 与 [1,2](值1,3)。
  // 值序最小会选 [1,2]；索引序最小必须选 [0,2]。
  const a = new SequenceLibrary();
  for (const v of [2, 1, 3]) a.append(v);
  assert.deepEqual(a.lisCertificate().indices, [0, 2]);
  assert.deepEqual(a.lisCertificate().values, [2, 3]);

  // [1,3,2]：候选 [0,1](值1,3) 与 [0,2](值1,2)，索引序最小为 [0,1]。
  const b = new SequenceLibrary();
  for (const v of [1, 3, 2]) b.append(v);
  assert.deepEqual(b.lisCertificate().indices, [0, 1]);
  assert.deepEqual(b.lisCertificate().values, [1, 3]);
});

test("边界：空序列、单元素、全相等、严格递减", () => {
  const empty = new SequenceLibrary();
  assert.deepEqual(empty.lisCertificate(), { length: 0, indices: [], values: [] });

  assertMatchesBruteForce([7]);
  assertMatchesBruteForce([4, 4, 4, 4]); // 全相等：唯一最优为某个单元素，索引最小即 [0]
  const eq = new SequenceLibrary();
  for (const v of [4, 4, 4, 4]) eq.append(v);
  assert.deepEqual(eq.lisCertificate().indices, [0]);
  assertMatchesBruteForce([9, 7, 5, 3, 1]);
});

test("小序列穷举：值域 {0,1,2}、长度 0..7 全部序列对照", () => {
  let checked = 0;
  let tieCases = 0;
  const seq: number[] = [];
  const walk = (depth: number): void => {
    assertMatchesBruteForce(seq);
    checked++;
    if (bruteForceAllBest(seq).length > 1) tieCases++;
    if (depth === 0) return;
    for (const v of [0, 1, 2]) {
      seq.push(v);
      walk(depth - 1);
      seq.pop();
    }
  };
  walk(7);
  assert.equal(checked, (3 ** 8 - 1) / 2); // 1 + 3 + ... + 3^7 = 3280
  assert.ok(tieCases > 0, "应覆盖到存在多个最优解的序列");
  console.log(`穷举对照 ${checked} 个序列，其中 ${tieCases} 个存在多个最优解（打破并列生效）`);
});

test("小序列穷举：值域 {1..4}、长度 0..6 全部序列对照", () => {
  let checked = 0;
  const seq: number[] = [];
  const walk = (depth: number): void => {
    assertMatchesBruteForce(seq);
    checked++;
    if (depth === 0) return;
    for (const v of [1, 2, 3, 4]) {
      seq.push(v);
      walk(depth - 1);
      seq.pop();
    }
  };
  walk(6);
  assert.equal(checked, (4 ** 7 - 1) / 3); // 5461
  console.log(`穷举对照 ${checked} 个序列`);
});

test("随机序列对照（固定种子，长度至 12）", () => {
  let state = 0x9e3779b9;
  const rand = (): number => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  for (let trial = 0; trial < 300; trial++) {
    const n = Math.floor(rand() * 13);
    const seq = Array.from({ length: n }, () => Math.floor(rand() * 8));
    assertMatchesBruteForce(seq);
  }
});

test("证书校验：拒绝被篡改的证书", () => {
  const lib = new SequenceLibrary();
  for (const v of [2, 1, 3]) lib.append(v);
  const good: LisCertificate = lib.lisCertificate();
  assert.ok(lib.verifyCertificate(good));
  // 下标 [1,2]（值 1,3）是合法最优证书，只是不是索引序最小的规范解：校验仍应通过。
  assert.ok(lib.verifyCertificate({ length: 2, indices: [1, 2], values: [1, 3] }));
  assert.ok(!lib.verifyCertificate({ ...good, length: 3 }));       // 长度虚报
  assert.ok(!lib.verifyCertificate({ ...good, values: [2, 4] }));  // 值与序列不符
  assert.ok(!lib.verifyCertificate({ ...good, indices: [2, 0] })); // 下标非递增
  assert.ok(!lib.verifyCertificate({ ...good, indices: [0, 3] })); // 下标越界
});
