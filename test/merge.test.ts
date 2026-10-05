import { test } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  del,
  fromRaw,
  materialize,
  mergeLayers,
  mergeNode,
  NamedLayer,
  ProvEntry,
} from "../src/merge";
import { resolveDirect } from "../src/direct";
import { exampleLayers } from "../src/example";

const L = (name: string, config: unknown): NamedLayer => ({ name, config });

function provMap(entries: ProvEntry[]): Map<string, ProvEntry> {
  const m = new Map<string, ProvEntry>();
  for (const e of entries) m.set(e.path, e);
  return m;
}

test("对象按键递归合并，标量由高层覆盖", () => {
  const { value } = mergeLayers([
    L("low", { a: { b: 1, c: 2 }, d: "x" }),
    L("high", { a: { c: 3, e: 4 }, d: "y" }),
  ]);
  deepStrictEqual(value, { a: { b: 1, c: 3, e: 4 }, d: "y" });
});

test("数组按稳定 id 合并：同 id 递归合并、新 id 追加、顺序保持", () => {
  const { value } = mergeLayers([
    L("low", { p: [{ id: "a", x: 1, nested: { m: 1 } }, { id: "b", y: 2 }] }),
    L("high", { p: [{ id: "b", y: 20, z: 3 }, { id: "c", w: 4 }, { id: "a", nested: { n: 2 } }] }),
  ]);
  deepStrictEqual(value, {
    p: [
      { id: "a", x: 1, nested: { m: 1, n: 2 } },
      { id: "b", y: 20, z: 3 },
      { id: "c", w: 4 },
    ],
  });
});

test("显式删除：对象键与数组元素（按 id）", () => {
  const { value, provenance } = mergeLayers([
    L("low", { keep: 1, drop: 2, p: [{ id: "a" }, { id: "b" }] }),
    L("high", { drop: del(), p: [{ id: "a", ...del() }] }),
  ]);
  deepStrictEqual(value, { keep: 1, p: [{ id: "b" }] });
  const m = provMap(provenance);
  strictEqual(m.get("drop")?.kind, "delete");
  strictEqual(m.get("drop")?.source, "high");
  strictEqual(m.get("p[id=a]")?.kind, "delete");
});

test("删除不存在的项也保留墓碑，遮蔽祖先层", () => {
  // L2 删除 phantom 时，L2 自身并无 phantom；墓碑保留，合并 L1 时遮蔽之
  const l1 = L("L1", { p: [{ id: "phantom", v: 1 }], obj: { ghost: 1, real: 2 } });
  const l2 = L("L2", { p: [{ id: "phantom", ...del() }], obj: { ghost: del() } });
  const { value, provenance } = mergeLayers([l1, l2]);
  deepStrictEqual(value, { p: [], obj: { real: 2 } });
  const m = provMap(provenance);
  strictEqual(m.get("p[id=phantom]")?.kind, "delete");
  strictEqual(m.get("obj.ghost")?.kind, "delete");

  // 右折叠场景：先合并高层（墓碑无实体可删，仍保留），再与祖先合并
  const n1 = fromRaw(l1.config, "L1", "id");
  const n2 = fromRaw(l2.config, "L2", "id");
  const rightFold = materialize(mergeNode(n1, mergeNode(n2, n2)));
  deepStrictEqual(rightFold, { p: [], obj: { real: 2 } });
});

test("类型变化整项替换", () => {
  const { value } = mergeLayers([
    L("low", { a: "str", b: { x: 1 }, c: [1, 2], d: 42 }),
    L("high", { a: { k: 1 }, b: "now-scalar", c: 7, d: [{ id: "z" }] }),
  ]);
  deepStrictEqual(value, { a: { k: 1 }, b: "now-scalar", c: 7, d: [{ id: "z" }] });
});

test("删除后由更高层重新引入（祖先被遮蔽，不参与合并）", () => {
  const { value } = mergeLayers([
    L("l1", { a: { old: 1, gone: 2 } }),
    L("l2", { a: del() }),
    L("l3", { a: { fresh: 3 } }),
  ]);
  deepStrictEqual(value, { a: { fresh: 3 } });
});

test("无稳定 id 的数组元素整组由高层替换", () => {
  const { value } = mergeLayers([
    L("low", { tags: ["a", "b"], nums: [1] }),
    L("high", { tags: ["c"] }),
  ]);
  deepStrictEqual(value, { tags: ["c"], nums: [1] });
});

test("单层恒等（无删除标记时）", () => {
  const cfg = { a: { b: [1, { id: "x", v: 2 }], c: "s" }, d: null };
  const { value } = mergeLayers([L("only", cfg)]);
  deepStrictEqual(value, cfg);
});

test("示例三层：顺序合并 ≡ 直接规则求值（值与逐项来源均一致）", () => {
  const seq = mergeLayers(exampleLayers);
  const dir = resolveDirect(exampleLayers);
  deepStrictEqual(seq.value, dir.value);

  const dirMap = new Map(dir.provenance.filter((e) => e.kind !== "structure").map((e) => [e.path, e]));
  const seqMap = provMap(seq.provenance);
  strictEqual(seqMap.size, dirMap.size);
  for (const [path, e] of seqMap) {
    const d = dirMap.get(path);
    ok(d, `直接求值缺少路径 ${path}`);
    strictEqual(e.source, d!.source, `路径 ${path} 来源不一致`);
    strictEqual(e.kind, d!.kind, `路径 ${path} 类别不一致`);
  }
});

// ---------------------------------------------------------------------------
// 随机化性质测试：结合律 + 与直接求值一致
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genObject(rng: () => number, depth: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const n = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const k = "k" + Math.floor(rng() * 6);
    if (rng() < 0.08) o[k] = del();
    else o[k] = genValue(rng, depth);
  }
  return o;
}

function genArray(rng: () => number, depth: number): unknown[] {
  const arr: unknown[] = [];
  const n = Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    if (rng() < 0.6) {
      const id = "p" + Math.floor(rng() * 4);
      if (rng() < 0.15) arr.push({ id, ...del() });
      else arr.push({ id, ...genObject(rng, depth) });
    } else {
      arr.push(genValue(rng, depth));
    }
  }
  return arr;
}

function genValue(rng: () => number, depth: number): unknown {
  const r = rng();
  if (depth <= 0 || r < 0.35) {
    const s = rng();
    if (s < 0.3) return Math.floor(rng() * 100);
    if (s < 0.55) return "s" + Math.floor(rng() * 5);
    if (s < 0.75) return rng() < 0.5;
    return null;
  }
  if (r < 0.7) return genObject(rng, depth - 1);
  return genArray(rng, depth - 1);
}

test("随机三层：结合律成立且与直接规则求值一致（300 轮）", () => {
  for (let trial = 0; trial < 300; trial++) {
    const rng = mulberry32(trial * 7919 + 1);
    const layers = [
      L("L1", genObject(rng, 3)),
      L("L2", genObject(rng, 3)),
      L("L3", genObject(rng, 3)),
    ];
    const [a, b, c] = layers.map((l) => fromRaw(l.config, l.name, "id"));
    const leftFold = materialize(mergeNode(mergeNode(a!, b!), c!));
    const rightFold = materialize(mergeNode(a!, mergeNode(b!, c!)));
    deepStrictEqual(leftFold, rightFold, `结合律失败（种子 ${trial}）`);
    const direct = resolveDirect(layers).value;
    deepStrictEqual(leftFold, direct, `与直接求值不一致（种子 ${trial}）`);
    const seq = mergeLayers(layers).value;
    deepStrictEqual(seq, direct, `mergeLayers 与直接求值不一致（种子 ${trial}）`);
  }
});
