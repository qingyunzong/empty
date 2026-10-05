import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { Replica } from "../src/store.js";
import { SyncNetwork } from "../src/sync.js";

test("乱序合并收敛：多副本随机乱序投递后状态一致", () => {
  for (const seed of [1, 7, 42, 2026]) {
    const a = new Replica("A");
    const b = new Replica("B");
    const c = new Replica("C");
    const net = new SyncNetwork();
    net.connect(a, b, c);

    a.put("o1", "a1");
    b.put("o1", "b1");
    c.put("o2", "c1");
    a.remove("o2");
    b.put("o3", "b3");
    c.remove("o3");
    a.put("o4", "a4");

    net.sync({ shuffle: true, seed });
    net.sync({ shuffle: true, seed: seed + 1 }); // 第二轮补齐确认

    deepEqual(a.dump(), b.dump(), `seed=${seed}: A 与 B 应收敛`);
    deepEqual(b.dump(), c.dump(), `seed=${seed}: B 与 C 应收敛`);
    // 确定性结果：o1 取最后写入者，o2/o3 为墓碑，o4 存活
    const byId = new Map(a.dump().map((r) => [r.id, r]));
    equal(byId.get("o1")!.deleted, false);
    equal(byId.get("o2")!.deleted, true);
    equal(byId.get("o3")!.deleted, true);
    equal(byId.get("o4")!.data, "a4");
  }
});

test("并发写同对象按 HLC 决胜，全副本结果一致", () => {
  const a = new Replica("A");
  const b = new Replica("B");
  const net = new SyncNetwork();
  net.connect(a, b);
  a.put("x", "from-a");
  b.put("x", "from-b"); // 与 A 并发（相同 time，replica 决胜）
  net.sync({ shuffle: true, seed: 9 });
  deepEqual(a.dump(), b.dump());
  equal(a.records.get("x")!.data, "from-b", "time 相同按 replica ID 决胜");
});
