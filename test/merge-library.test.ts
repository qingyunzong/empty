import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDelta, type Delta } from "../src/delta.js";
import { MergeLibrary } from "../src/merge-library.js";

/** 确定性伪随机数（mulberry32），用于可复现的乱序重放。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 构造一棵带分支与隔离子树的差量集（拓扑序）。 */
function buildDeltaSet(): Delta[] {
  const deltas: Delta[] = [
    makeDelta("root", null, { app: "demo", rev: 0 }),
    makeDelta("a1", "root", { rev: 1, title: "hello" }),
    makeDelta("a2", "a1", { rev: 2, title: "hello world" }),
    makeDelta("b1", "a1", { rev: 2, draft: true }), // 分支 b
    makeDelta("a3", "a2", { rev: 3, tags: ["x"] }),
    makeDelta("b2", "b1", { rev: 3, draft: false }),
  ];
  // 坏摘要子树：bad 的摘要被篡改，其后继应被一并隔离。
  const bad = makeDelta("bad", "root", { rev: 9, evil: true });
  bad.checksum = "0".repeat(64);
  deltas.push(bad);
  deltas.push(makeDelta("bad-child", "bad", { rev: 10 }));
  deltas.push(makeDelta("bad-grandchild", "bad-child", { rev: 11 }));
  return deltas;
}

test("父缺失时缓冲，父到达后自动落图（含孙代递归冲刷）", () => {
  const lib = new MergeLibrary();
  const root = makeDelta("root", null, { v: 0 });
  const child = makeDelta("child", "root", { v: 1 });
  const grandchild = makeDelta("grandchild", "child", { v: 2 });

  // 乱序到达：孙代、子代都在父之前。
  assert.deepEqual(lib.ingest(grandchild), {
    status: "buffered",
    id: "grandchild",
    waitingFor: "child",
  });
  assert.deepEqual(lib.ingest(child), {
    status: "buffered",
    id: "child",
    waitingFor: "root",
  });
  assert.deepEqual(lib.buffered(), ["child", "grandchild"]);

  assert.deepEqual(lib.ingest(root), { status: "applied", id: "root" });
  assert.deepEqual(lib.buffered(), []);
  assert.deepEqual(
    lib.query("grandchild").map((d) => d.id),
    ["root", "child", "grandchild"],
  );
});

test("多分支不强行线性化，查询必须指定分支头", () => {
  const lib = new MergeLibrary();
  lib.ingest(makeDelta("root", null, { rev: 0 }));
  lib.ingest(makeDelta("left", "root", { rev: 1, side: "L" }));
  lib.ingest(makeDelta("right", "root", { rev: 1, side: "R" }));

  // 两个分支头并存，不合并为单链。
  assert.deepEqual(lib.heads(), ["left", "right"]);

  // 查询必须显式指定分支头。
  assert.throws(
    () => lib.query(undefined as unknown as string),
    /必须指定分支头/,
  );
  assert.throws(() => lib.query("nope"), /未知分支头/);

  // 各分支路径互不包含对方（未线性化）。
  assert.deepEqual(
    lib.query("left").map((d) => d.id),
    ["root", "left"],
  );
  assert.deepEqual(lib.mergeState("right"), { rev: 1, side: "R" });
});

test("坏摘要被隔离，其后继（含乱序补到的）一并隔离", () => {
  const lib = new MergeLibrary();
  lib.ingest(makeDelta("root", null, { rev: 0 }));

  // 后继先到达，进入缓冲。
  const grandchild = makeDelta("grandchild", "child", { rev: 3 });
  const child = makeDelta("child", "bad", { rev: 2 });
  assert.equal(lib.ingest(grandchild).status, "buffered");
  assert.equal(lib.ingest(child).status, "buffered");

  // 坏摘要版本到达：本体隔离，缓冲中的后继随父落图时一并隔离。
  const bad = makeDelta("bad", "root", { rev: 1, evil: true });
  bad.checksum = "f".repeat(64);
  assert.deepEqual(lib.ingest(bad), { status: "quarantined", id: "bad" });

  assert.deepEqual(lib.isolated(), ["bad", "child", "grandchild"]);
  assert.deepEqual(lib.heads(), ["root"]);
  assert.throws(() => lib.query("grandchild"), /已被隔离/);
});

test("乱序重放与完整版本图构建结果等价（多种子对照）", () => {
  const deltas = buildDeltaSet();
  const complete = MergeLibrary.replay(deltas); // 拓扑序完整构建

  for (const seed of [1, 7, 42, 1337, 20261006]) {
    const replayed = MergeLibrary.replay(shuffled(deltas, seed));
    assert.ok(
      MergeLibrary.equivalent(complete, replayed),
      `seed=${seed} 乱序重放与完整构建不等价`,
    );
    assert.deepEqual(replayed.heads(), complete.heads());
    assert.deepEqual(replayed.isolated(), complete.isolated());
    assert.deepEqual(replayed.buffered(), []);
  }

  // 完整构建下的预期：坏摘要子树被隔离，其余分支正常。
  assert.deepEqual(complete.heads(), ["a3", "b2"]);
  assert.deepEqual(complete.isolated(), ["bad", "bad-child", "bad-grandchild"]);
  assert.deepEqual(complete.mergeState("a3"), {
    app: "demo",
    rev: 3,
    title: "hello world",
    tags: ["x"],
  });
});

test("重复接收同一差量为幂等空操作", () => {
  const lib = new MergeLibrary();
  const root = makeDelta("root", null, { v: 0 });
  assert.equal(lib.ingest(root).status, "applied");
  assert.deepEqual(lib.ingest(root), { status: "duplicate", id: "root" });
  assert.deepEqual(lib.heads(), ["root"]);
});
