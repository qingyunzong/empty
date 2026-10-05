import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { VersionedArray, type Replacement } from "../src/versioned-array.js";
import { sortedCountingMode, countOccurrences } from "../src/model.js";
import { mulberry32, randInt } from "../src/random.js";

describe("rangeMode 基本语义", () => {
  test("返回众数值与频次证据", () => {
    const va = new VersionedArray([5, 2, 5, 3, 2, 5]);
    const ev = va.rangeMode(0, 0, 5);
    assert.ok(ev);
    assert.equal(ev.value, 5);
    assert.equal(ev.frequency, 3);
    assert.deepEqual(ev.positions, [0, 2, 5]); // 证据：5 出现的全部下标
    assert.equal(ev.versionId, 0);
  });

  test("频次并列时取数值较小者", () => {
    const va = new VersionedArray([7, 3, 7, 3]);
    const ev = va.rangeMode(0, 0, 3);
    assert.ok(ev);
    assert.equal(ev.value, 3);
    assert.equal(ev.frequency, 2);
  });

  test("子范围查询只统计区间内元素", () => {
    const va = new VersionedArray([9, 9, 1, 1, 1, 2]);
    const ev = va.rangeMode(0, 2, 5);
    assert.ok(ev);
    assert.equal(ev.value, 1);
    assert.equal(ev.frequency, 3);
    assert.deepEqual(ev.positions, [2, 3, 4]);
  });

  test("空范围（from > to）返回 null", () => {
    const va = new VersionedArray([1, 2, 3]);
    assert.equal(va.rangeMode(0, 2, 1), null);
    assert.equal(va.rangeMode(0, 1, 1)!.value, 2); // 单元素范围正常
  });

  test("越界范围与不存在的版本抛 RangeError", () => {
    const va = new VersionedArray([1, 2, 3]);
    assert.throws(() => va.rangeMode(0, -1, 2), RangeError);
    assert.throws(() => va.rangeMode(0, 0, 3), RangeError);
    assert.throws(() => va.rangeMode(7, 0, 2), RangeError);
  });
});

describe("块更新原子性与版本持久化", () => {
  test("合法块更新产生新版本，旧版本仍可查询", () => {
    const va = new VersionedArray([4, 4, 1, 1, 1]);
    const before = va.rangeMode(0, 0, 4)!;
    assert.equal(before.value, 1);

    const v1 = va.applyBlock([
      { index: 0, value: 4 },
      { index: 3, value: 4 },
    ]);
    assert.equal(v1.id, 1);
    assert.equal(va.versionCount, 2);
    assert.deepEqual(v1.toArray(), [4, 4, 1, 4, 1]);

    // 新版本众数变为 4
    const after = va.rangeMode(1, 0, 4)!;
    assert.equal(after.value, 4);
    assert.equal(after.frequency, 3);
    // 旧版本查询结果不变
    const again = va.rangeMode(0, 0, 4)!;
    assert.equal(again.value, 1);
    assert.equal(again.frequency, 3);
  });

  test("非法块整体拒绝：越界下标", () => {
    const va = new VersionedArray([1, 2, 3]);
    assert.throws(
      () => va.applyBlock([{ index: 0, value: 9 }, { index: 5, value: 8 }]),
      RangeError,
    );
    assert.equal(va.versionCount, 1); // 原子：无新版本
    assert.deepEqual(va.version(0).toArray(), [1, 2, 3]); // 原状态未受污染
  });

  test("非法块整体拒绝：非整数值与块内重复下标", () => {
    const va = new VersionedArray([1, 2, 3]);
    assert.throws(() => va.applyBlock([{ index: 1, value: 2.5 }]), TypeError);
    assert.throws(
      () =>
        va.applyBlock([
          { index: 0, value: 7 },
          { index: 0, value: 8 },
        ]),
      /duplicate index/,
    );
    assert.equal(va.versionCount, 1);
  });

  test("空块为无操作，不产生新版本", () => {
    const va = new VersionedArray([1, 2]);
    const v = va.applyBlock([]);
    assert.equal(v.id, 0);
    assert.equal(va.versionCount, 1);
  });
});

describe("随机核对：排序计数模型 vs 库实现", () => {
  const SEEDS = [1, 42, 20261005];
  const ROUNDS_PER_SEED = 40;
  const QUERIES_PER_ROUND = 12;

  test("随机替换 + 随机范围（含空范围）全量对照", () => {
    let checked = 0;
    let emptyChecked = 0;
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let round = 0; round < ROUNDS_PER_SEED; round++) {
        const n = randInt(rng, 1, 24);
        const initial: number[] = [];
        for (let i = 0; i < n; i++) initial.push(randInt(rng, -4, 4)); // 小值域 → 并列频发
        const va = new VersionedArray(initial);
        const snapshots: number[][] = [initial.slice()];

        // 随机块更新序列（含随机替换）
        const blocks = randInt(rng, 0, 6);
        for (let b = 0; b < blocks; b++) {
          const size = randInt(rng, 1, Math.min(5, n));
          const picked = new Set<number>();
          const repl: Replacement[] = [];
          while (repl.length < size) {
            const idx = randInt(rng, 0, n - 1);
            if (picked.has(idx)) continue;
            picked.add(idx);
            repl.push({ index: idx, value: randInt(rng, -4, 4) });
          }
          va.applyBlock(repl);
          snapshots.push(va.version(va.latestId).toArray().slice());
        }

        // 随机范围查询（约 1/4 构造为空范围），与排序计数模型对照
        for (let q = 0; q < QUERIES_PER_ROUND; q++) {
          const versionId = randInt(rng, 0, va.latestId); // 含旧版本
          const snap = snapshots[versionId]!;
          let from = randInt(rng, 0, n - 1);
          let to = randInt(rng, 0, n - 1);
          if (rng() < 0.25) {
            to = from - 1; // 空范围
          } else if (from > to) {
            [from, to] = [to, from];
          }

          const ev = va.rangeMode(versionId, from, to);
          const model = sortedCountingMode(snap, from, to);

          if (from > to) {
            assert.equal(ev, null);
            assert.equal(model, null);
            emptyChecked++;
            continue;
          }
          assert.ok(ev);
          assert.ok(model);
          assert.equal(
            ev.value,
            model.value,
            `seed=${seed} round=${round} v=${versionId} [${from},${to}] snap=${snap.join(",")}`,
          );
          assert.equal(ev.frequency, model.frequency);

          // 证据核验：频次 = 独立计数；positions 与快照逐一吻合
          assert.equal(ev.frequency, countOccurrences(snap, from, to, ev.value));
          assert.equal(ev.positions.length, ev.frequency);
          for (const p of ev.positions) {
            assert.ok(from <= p && p <= to);
            assert.equal(snap[p], ev.value);
          }
          checked++;
        }
      }
    }
    console.log(
      `  [随机核对] 非空范围对照 ${checked} 次，空范围 ${emptyChecked} 次，全部一致`,
    );
    assert.ok(checked > 1000, "sanity: enough random cases ran");
    assert.ok(emptyChecked > 100, "sanity: empty ranges covered");
  });
});
