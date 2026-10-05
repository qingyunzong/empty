import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  MAX_PROJECTION_DIMS,
  TagStats,
  type ComboCount,
  type TagSet,
} from "../src/stats.js";

/** 把投影结果转成 Map(JSON(tags) -> count)，便于无序比较。 */
function toMap(rows: readonly ComboCount[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify(
      Object.keys(row.tags)
        .sort()
        .map((d) => [d, row.tags[d]]),
    );
    map.set(key, row.count);
  }
  return map;
}

/** 独立实现的暴力投影：从事件清单逐条投影折叠，作为参照。 */
function bruteForce(
  events: ReadonlyMap<string, TagSet>,
  dims: readonly string[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const tags of events.values()) {
    const pairs: string[][] = [];
    for (const d of [...dims].sort()) {
      if (Object.prototype.hasOwnProperty.call(tags, d)) pairs.push([d, tags[d]!]);
    }
    const key = JSON.stringify(pairs);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("publish 后按全维度组合计数", () => {
  const stats = new TagStats();
  stats.publish("e1", { env: "prod", region: "cn" });
  stats.publish("e2", { env: "prod", region: "cn" });
  stats.publish("e3", { env: "dev", region: "cn" });
  assert.deepEqual(toMap(stats.query(["env", "region"])), toMap([
    { tags: { env: "prod", region: "cn" }, count: 2 },
    { tags: { env: "dev", region: "cn" }, count: 1 },
  ]));
  assert.equal(stats.eventCount, 3);
  assert.equal(stats.comboCount, 2);
  assert.equal(stats.verify().ok, true);
});

test("空标签不等于缺失标签", () => {
  const stats = new TagStats();
  stats.publish("missing", {}); // 缺失 env
  stats.publish("empty", { env: "" }); // 空标签
  stats.publish("prod", { env: "prod" });
  const rows = stats.query(["env"]);
  assert.equal(rows.length, 3);
  const map = toMap(rows);
  assert.equal(map.get(JSON.stringify([])), 1); // 缺失组
  assert.equal(map.get(JSON.stringify([["env", ""]])), 1); // 空标签组
  assert.equal(map.get(JSON.stringify([["env", "prod"]])), 1);
  // 空标签事件可以按空值精确区分出来
  assert.deepEqual(stats.tagsOf("empty"), { env: "" });
  assert.deepEqual(stats.tagsOf("missing"), {});
  assert.equal(stats.verify(["env"]).ok, true);
});

test("投影支持 0..4 维，超过 4 维或维度重复被拒绝", () => {
  const stats = new TagStats();
  stats.publish("e1", { a: "1", b: "2", c: "3", d: "4", e: "5" });
  assert.deepEqual(stats.query([]), [{ tags: {}, count: 1 }]); // 0 维 = 总计数
  assert.equal(stats.query(["a", "b", "c", "d"]).length, 1); // 4 维可行
  assert.equal(MAX_PROJECTION_DIMS, 4);
  assert.throws(
    () => stats.query(["a", "b", "c", "d", "e"]),
    (err) => err instanceof RangeError,
  );
  assert.throws(() => stats.query(["a", "a"]), TypeError);
  assert.throws(() => stats.query([""]), TypeError);
});

test("correct 撤旧加新原子发布，返回稀疏差分", () => {
  const stats = new TagStats();
  stats.publish("e1", { env: "prod", tier: "gold" });
  stats.publish("e2", { env: "prod", tier: "gold" });
  const diff = stats.correct("e1", { env: "prod", tier: "silver" });
  assert.deepEqual(diff, [
    { tags: { env: "prod", tier: "gold" }, before: 2, after: 1, delta: -1 },
    { tags: { env: "prod", tier: "silver" }, before: 0, after: 1, delta: 1 },
  ]);
  assert.deepEqual(toMap(stats.query(["tier"])), toMap([
    { tags: { tier: "gold" }, count: 1 },
    { tags: { tier: "silver" }, count: 1 },
  ]));
  // 无变化更正是无操作，差分为空
  assert.deepEqual(stats.correct("e1", { env: "prod", tier: "silver" }), []);
  assert.equal(stats.verify().ok, true);
});

test("correct 校验失败不产生任何部分状态", () => {
  const stats = new TagStats();
  stats.publish("e1", { env: "prod" });
  const before = stats.query(["env"]);
  assert.throws(() => stats.correct("ghost", { env: "dev" }), /不存在/);
  assert.throws(
    () => stats.correct("e1", { env: 42 as unknown as string }),
    TypeError,
  );
  assert.throws(
    () => stats.correct("e1", { "": "x" }),
    TypeError,
  );
  assert.deepEqual(stats.query(["env"]), before); // 状态原封不动
  assert.equal(stats.eventCount, 1);
  assert.equal(stats.verify().ok, true);
});

test("publish 重复 ID 与 retract 语义", () => {
  const stats = new TagStats();
  stats.publish("e1", { env: "prod" });
  assert.throws(() => stats.publish("e1", { env: "dev" }), /已存在/);
  const diff = stats.retract("e1");
  assert.deepEqual(diff, [
    { tags: { env: "prod" }, before: 1, after: 0, delta: -1 },
  ]);
  assert.equal(stats.comboCount, 0); // 归零组合被稀疏移除
  assert.throws(() => stats.retract("e1"), /不存在/);
  assert.equal(stats.verify().ok, true);
});

test("查询结果与差分按键排序，输出确定", () => {
  const stats = new TagStats();
  stats.publish("e1", { b: "2", a: "1" });
  stats.publish("e2", { a: "0" });
  const rows = stats.query(["a"]);
  assert.deepEqual(rows, [
    { tags: { a: "0" }, count: 1 },
    { tags: { a: "1" }, count: 1 },
  ]);
});

test("随机操作序列：每次操作后 verify，并用全部事件逐条投影核对所有 <=4 维投影", () => {
  const dims = ["env", "region", "app", "tier", "dc"];
  const values = ["", "a", "b", "prod"];
  const rng = mulberry32(20261005);
  const stats = new TagStats();
  const mirror = new Map<string, TagSet>();
  const ids = Array.from({ length: 40 }, (_, i) => `e${i}`);

  const randomTags = (): Record<string, string> => {
    const tags: Record<string, string> = {};
    for (const d of dims) {
      if (rng() < 0.6) tags[d] = values[Math.floor(rng() * values.length)]!;
    }
    return tags;
  };

  for (let op = 0; op < 3000; op++) {
    const id = ids[Math.floor(rng() * ids.length)]!;
    const exists = mirror.has(id);
    const roll = rng();
    if (!exists || roll < 0.55) {
      if (exists) {
        const tags = randomTags();
        stats.correct(id, tags);
        mirror.set(id, tags);
      } else {
        const tags = randomTags();
        stats.publish(id, tags);
        mirror.set(id, tags);
      }
    } else if (roll < 0.7) {
      stats.retract(id);
      mirror.delete(id);
    } else {
      const tags = randomTags();
      stats.correct(id, tags);
      mirror.set(id, tags);
    }
    const result = stats.verify();
    assert.equal(
      result.ok,
      true,
      `第 ${op} 步后全量核对失败: ${JSON.stringify(result.mismatches)}`,
    );
  }

  // 全部 0..4 维子集投影，与暴力参照逐一比对
  const subsets: string[][] = [[]];
  for (let size = 1; size <= MAX_PROJECTION_DIMS; size++) {
    const pick = (start: number, acc: string[]): void => {
      if (acc.length === size) {
        subsets.push([...acc]);
        return;
      }
      for (let i = start; i < dims.length; i++) {
        acc.push(dims[i]!);
        pick(i + 1, acc);
        acc.pop();
      }
    };
    pick(0, []);
  }
  assert.equal(subsets.length, 31);
  for (const subset of subsets) {
    assert.deepEqual(
      toMap(stats.query(subset)),
      bruteForce(mirror, subset),
      `投影 [${subset.join(",")}] 与逐条投影核对不一致`,
    );
    assert.equal(stats.verify(subset).ok, true, `verify([${subset}]) 失败`);
  }
});
