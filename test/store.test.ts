import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EventStatsStore,
  Snapshot,
  diffProjections,
  encodeCell,
  decodeCell,
  normalizeLabels,
  comboKeyOf,
  type Labels,
  type CellValue,
} from "../src/store.js";

/** 测试侧的独立暴力投影：逐条事件扫描。 */
function bruteForceProject(
  events: ReadonlyMap<string, Labels>,
  dims: readonly string[],
): Map<string, number> {
  const sorted = [...new Set(dims)].sort();
  const out = new Map<string, number>();
  for (const labels of events.values()) {
    const cell = encodeCell(
      sorted.map((d) => (Object.hasOwn(labels, d) ? labels[d]! : null)),
    );
    out.set(cell, (out.get(cell) ?? 0) + 1);
  }
  return out;
}

function allSubsets(dims: string[], minSize: number, maxSize: number): string[][] {
  const out: string[][] = [];
  const walk = (start: number, picked: string[]): void => {
    if (picked.length >= minSize) out.push([...picked]);
    if (picked.length === maxSize) return;
    for (let i = start; i < dims.length; i++) {
      picked.push(dims[i]!);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

test("空标签不等于缺失标签", () => {
  const store = new EventStatsStore();
  store.correct("e-empty", { env: "" }); // 空标签
  store.correct("e-missing", {}); // 缺失 env 维度
  store.correct("e-prod", { env: "prod" });

  const snap = store.getSnapshot();
  const proj = snap.project(["env"]);
  assert.equal(proj.get(encodeCell([""])), 1, "空标签单独成格");
  assert.equal(proj.get(encodeCell([null])), 1, "缺失标签单独成格");
  assert.equal(proj.get(encodeCell(["prod"])), 1);
  assert.equal(proj.size, 3, "空/缺失/普通三者互不合并");

  // 完整组合层面同样区分
  const counts = snap.comboCounts();
  assert.equal(counts.get(comboKeyOf({ env: "" })), 1);
  assert.equal(counts.get(comboKeyOf({})), 1);
  assert.notEqual(comboKeyOf({ env: "" }), comboKeyOf({}));

  // 逐条核对通过
  assert.deepEqual(snap.verify(["env"]), []);
});

test("更正 = 撤旧加新，原子发布，旧快照不受污染", () => {
  const store = new EventStatsStore();
  store.correct("e1", { region: "cn", env: "prod" });
  store.correct("e2", { region: "cn", env: "dev" });
  const before = store.getSnapshot();

  const { before: returnedBefore, after } = store.correct("e1", {
    region: "us",
    env: "prod",
  });
  assert.equal(returnedBefore, before);

  // 旧快照保持旧值（原子发布前的状态完整可读）
  assert.equal(before.project(["region"]).get(encodeCell(["cn"])), 2);
  assert.equal(before.project(["region"]).get(encodeCell(["us"])), undefined);
  assert.equal(before.version + 1, after.version);

  // 新快照：旧组合撤销、新组合加入
  const region = after.project(["region"]);
  assert.equal(region.get(encodeCell(["cn"])), 1);
  assert.equal(region.get(encodeCell(["us"])), 1);
  const env = after.project(["env"]);
  assert.equal(env.get(encodeCell(["prod"])), 1);
  assert.equal(env.get(encodeCell(["dev"])), 1);
  assert.equal(after.eventCount, 2, "同一事件不会重复计数");

  // 发布过程中没有中间态暴露：getSnapshot 只可能拿到 before 或 after
  const current = store.getSnapshot();
  assert.ok(current === before || current === after);

  // 相同标签的更正是空操作，不发布新版本
  const noop = store.correct("e1", { env: "prod", region: "us" });
  assert.equal(noop.after, after, "空操作复用同一快照");
  assert.equal(diffProjections(noop.before, noop.after, ["region"]).length, 0);

  // 删除事件（labels = null）
  const del = store.correct("e2", null);
  assert.equal(del.after.eventCount, 1);
  assert.equal(del.after.project(["env"]).get(encodeCell(["dev"])), undefined);
  assert.deepEqual(del.after.verify(["region", "env"]), []);
});

test("最多 4 维任意投影，并与逐条暴力投影核对（确定性数据集）", () => {
  const store = new EventStatsStore();
  const events = new Map<string, Labels>();
  const fixtures: Array<[string, Labels]> = [
    ["a1", { region: "cn", env: "prod", service: "api", status: "ok", tenant: "t1" }],
    ["a2", { region: "cn", env: "prod", service: "web", status: "err" }],
    ["a3", { region: "us", env: "", service: "api", status: "ok", tenant: "" }],
    ["a4", { region: "us", service: "web" }],
    ["a5", { env: "dev", status: "ok", tenant: "t1" }],
    ["a6", {}],
    ["a7", { region: "cn", env: "dev", service: "api", status: "err", tenant: "t2" }],
    ["a8", { region: "", env: "", service: "", status: "", tenant: "" }],
  ];
  for (const [id, labels] of fixtures) {
    store.correct(id, labels);
    events.set(id, normalizeLabels(labels));
  }
  // 再叠加若干更正，制造撤旧加新
  const corrections: Array<[string, Labels | null]> = [
    ["a2", { region: "eu", env: "prod", service: "web", status: "ok", tenant: "t3" }],
    ["a6", { region: "cn", env: "prod" }],
    ["a4", null],
  ];
  for (const [id, labels] of corrections) {
    store.correct(id, labels);
    if (labels === null) events.delete(id);
    else events.set(id, normalizeLabels(labels));
  }

  const snap = store.getSnapshot();
  const dims = ["region", "env", "service", "status", "tenant"];
  const subsets = allSubsets(dims, 1, 4);
  assert.equal(subsets.length, 5 + 10 + 10 + 5, "C(5,1..4)=30 种投影");

  for (const proj of subsets) {
    // 库内核对：索引结果 vs 逐条事件投影
    assert.deepEqual(snap.verify(proj), [], `verify(${proj.join(",")})`);
    // 测试侧独立暴力实现交叉核对
    assert.deepEqual(
      snap.project(proj),
      bruteForceProject(events, proj),
      `project(${proj.join(",")})`,
    );
  }

  // 0 维投影 = 总数
  assert.equal(snap.project([]).get(encodeCell([])), events.size);
});

test("稀疏差分只包含变化的单元", () => {
  const store = new EventStatsStore();
  store.correct("e1", { region: "cn", env: "prod" });
  store.correct("e2", { region: "cn", env: "dev" });
  store.correct("e3", { region: "us", env: "prod" });
  const before = store.getSnapshot();

  store.correct("e1", { region: "us", env: "prod" }); // cn/prod -> us/prod
  store.correct("e4", { region: "cn", env: "" }); // 新增空标签
  const after = store.getSnapshot();

  const diff = diffProjections(before, after, ["region", "env"]);
  const byCell = new Map(diff.map((d) => [d.cellKey, d]));

  // 维度规范化为排序顺序 [env, region]；变化单元恰好 3 个：
  // prod/cn -1、prod/us +1、""/cn +1；dev/cn 不变（应缺席）
  assert.equal(diff.length, 3);
  assert.deepEqual(byCell.get(encodeCell(["prod", "cn"])), {
    cellKey: encodeCell(["prod", "cn"]),
    cell: ["prod", "cn"],
    before: 1,
    after: 0,
    delta: -1,
  });
  assert.deepEqual(byCell.get(encodeCell(["prod", "us"]))!.delta, 1);
  assert.deepEqual(byCell.get(encodeCell(["", "cn"]))!.delta, 1);
  assert.ok(!byCell.has(encodeCell(["dev", "cn"])), "未变化单元不出现在稀疏差分中");

  // 差分应用到 before 投影上应还原 after 投影
  const merged = before.project(["region", "env"]);
  for (const d of diff) {
    const next = (merged.get(d.cellKey) ?? 0) + d.delta;
    if (next === 0) merged.delete(d.cellKey);
    else merged.set(d.cellKey, next);
  }
  assert.deepEqual(merged, after.project(["region", "env"]));

  // 一维投影的差分
  const regionDiff = diffProjections(before, after, ["region"]);
  assert.equal(regionDiff.length, 1); // us 1->2；cn 净变化 0（-1+1）故缺席
  assert.deepEqual(
    regionDiff.map((d) => [d.cell, d.delta]).sort(),
    [[["us"], 1]].sort(),
    "cn 净变化为 0，稀疏差分中只有 us",
  );
});

test("随机化压力：每步更正后全部 <=4 维投影逐条核对", () => {
  // 确定性 PRNG（mulberry32）
  let state = 0x9e3779b9;
  const rand = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const dims = ["region", "env", "service", "status", "tenant", "dc"];
  const values = ["cn", "us", "eu", "prod", "dev", "api", "web", "ok", "err", "t1", ""];
  const randomLabels = (): Labels => {
    const out: Record<string, string> = {};
    for (const d of dims) {
      if (rand() < 0.7) out[d] = pick(values);
    }
    return out;
  };

  const store = new EventStatsStore();
  const truth = new Map<string, Labels>();
  const subsets = allSubsets(dims, 1, 4); // C(6,1..4) = 6+15+20+15 = 56

  for (let step = 0; step < 400; step++) {
    const id = `ev-${Math.floor(rand() * 120)}`;
    const labels = rand() < 0.1 ? null : randomLabels();
    store.correct(id, labels);
    if (labels === null) truth.delete(id);
    else truth.set(id, normalizeLabels(labels));

    // 每 40 步做一次全量 56 投影核对，其余步骤抽查 3 个投影
    const toCheck = step % 40 === 0 ? subsets : [pick(subsets), pick(subsets), pick(subsets)];
    const snap = store.getSnapshot();
    for (const proj of toCheck) {
      assert.deepEqual(snap.verify(proj), [], `step=${step} verify(${proj.join(",")})`);
      assert.deepEqual(
        snap.project(proj),
        bruteForceProject(truth, proj),
        `step=${step} project(${proj.join(",")})`,
      );
    }
  }

  // 终态：全量核对 + 事件数一致
  const snap = store.getSnapshot();
  assert.equal(snap.eventCount, truth.size);
  for (const proj of subsets) {
    assert.deepEqual(snap.verify(proj), [], `final verify(${proj.join(",")})`);
  }
});

test("输入校验", () => {
  const store = new EventStatsStore();
  assert.throws(() => store.correct("e1", { env: 1 as unknown as string }), TypeError);
  assert.throws(() => store.correct("", { env: "prod" }), TypeError);
  assert.throws(() => store.correct("e1", { "": "x" }), TypeError);
  store.correct("e1", { a: "1", b: "2", c: "3", d: "4", e: "5" });
  const snap: Snapshot = store.getSnapshot();
  assert.throws(() => snap.project(["a", "b", "c", "d", "e"]), RangeError);
  assert.doesNotThrow(() => snap.project(["a", "b", "c", "d"]));
  // 重复维度自动去重
  assert.deepEqual(snap.project(["b", "a", "b"]), snap.project(["a", "b"]));
  // 单元编码往返
  const cell: CellValue[] = ["cn", "", null, "x"];
  assert.deepEqual(decodeCell(encodeCell(cell)), cell);
});
