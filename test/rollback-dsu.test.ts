import { test } from "node:test";
import assert from "node:assert/strict";
import { RollbackDSU } from "../src/rollback-dsu";

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

/**
 * 参照模型：只记录合并日志，不做任何增量维护。
 * 每次核验都从日志（截断到当前操作序号）逐条重建图，
 * 用 BFS 求连通分量及最小成员 ID。
 */
class RebuildModel {
  private readonly edges: [number, number][] = [];

  constructor(readonly n: number) {}

  union(a: number, b: number): void {
    this.edges.push([a, b]);
  }

  get opCount(): number {
    return this.edges.length;
  }

  rollback(snap: number): void {
    this.edges.length = snap;
  }

  /** 从边列表整体重建图，返回每个元素的根与分量最小成员。 */
  private rebuild(): { compOf: number[]; minOf: Map<number, number> } {
    const adj: number[][] = Array.from({ length: this.n }, () => []);
    for (const [a, b] of this.edges) {
      adj[a].push(b);
      adj[b].push(a);
    }
    const compOf = new Array<number>(this.n).fill(-1);
    const minOf = new Map<number, number>();
    for (let s = 0; s < this.n; s++) {
      if (compOf[s] !== -1) continue;
      let min = s;
      const stack = [s];
      compOf[s] = s;
      while (stack.length > 0) {
        const u = stack.pop() as number;
        if (u < min) min = u;
        for (const v of adj[u]) {
          if (compOf[v] === -1) {
            compOf[v] = s;
            stack.push(v);
          }
        }
      }
      minOf.set(s, min);
    }
    return { compOf, minOf };
  }

  find(x: number): number {
    const { compOf, minOf } = this.rebuild();
    return minOf.get(compOf[x]) as number;
  }

  connected(a: number, b: number): boolean {
    const { compOf } = this.rebuild();
    return compOf[a] === compOf[b];
  }

  /** 全量核验：对每个元素比较 find，对抽样点对比较 connected。 */
  verifyAll(dsu: RollbackDSU, rand: () => number): void {
    const { compOf, minOf } = this.rebuild();
    for (let x = 0; x < this.n; x++) {
      assert.equal(
        dsu.find(x),
        minOf.get(compOf[x]),
        `find(${x}) mismatch at op ${this.opCount}`,
      );
    }
    for (let i = 0; i < this.n * 2; i++) {
      const a = Math.floor(rand() * this.n);
      const b = Math.floor(rand() * this.n);
      assert.equal(
        dsu.connected(a, b),
        compOf[a] === compOf[b],
        `connected(${a}, ${b}) mismatch at op ${this.opCount}`,
      );
    }
  }
}

test("基本合并与最小成员 ID", () => {
  const dsu = new RollbackDSU(6);
  assert.equal(dsu.find(3), 3);
  dsu.union(4, 2);
  dsu.union(2, 5);
  assert.equal(dsu.find(5), 2);
  assert.ok(dsu.connected(4, 5));
  assert.ok(!dsu.connected(0, 5));
  dsu.union(5, 0);
  assert.equal(dsu.find(4), 0);
  assert.equal(dsu.componentSize(2), 4);
});

test("重复合并也占操作序号", () => {
  const dsu = new RollbackDSU(4);
  const s0 = dsu.snapshot();
  assert.equal(dsu.union(1, 2), true);
  const s1 = dsu.snapshot();
  assert.equal(dsu.union(1, 2), false);
  assert.equal(dsu.union(2, 1), false);
  assert.equal(dsu.opCount, s0 + 3);

  dsu.rollback(s1);
  assert.ok(dsu.connected(1, 2), "撤销重复合并后仍应连通");
  dsu.rollback(s0);
  assert.ok(!dsu.connected(1, 2), "撤销首次合并后应断开");
  assert.equal(dsu.opCount, 0);
});

test("回滚撤销快照之后的合并并恢复最小成员", () => {
  const dsu = new RollbackDSU(8);
  dsu.union(7, 3);
  const snap = dsu.snapshot();
  dsu.union(3, 1);
  dsu.union(0, 5);
  dsu.union(5, 7);
  assert.equal(dsu.find(7), 0);
  assert.equal(dsu.componentSize(1), 5);

  dsu.rollback(snap);
  assert.equal(dsu.find(7), 3);
  assert.equal(dsu.find(1), 1);
  assert.equal(dsu.find(0), 0);
  assert.equal(dsu.componentSize(3), 2);
  assert.ok(!dsu.connected(0, 5));
});

test("find 不做路径压缩（父指针不被改写）", () => {
  const dsu = new RollbackDSU(16);
  for (let i = 1; i < 16; i++) {
    dsu.union(0, i);
  }
  const internals = dsu as unknown as { parent: number[] };
  const before = internals.parent.slice();
  for (let i = 0; i < 16; i++) {
    dsu.find(i);
    dsu.connected(0, i);
  }
  assert.deepEqual(internals.parent, before, "find/connected 不得修改父指针");
});

test("非法快照与越界元素抛错", () => {
  const dsu = new RollbackDSU(3);
  dsu.union(0, 1);
  assert.throws(() => dsu.rollback(2), RangeError);
  assert.throws(() => dsu.rollback(-1), RangeError);
  assert.throws(() => dsu.find(3), RangeError);
  assert.throws(() => new RollbackDSU(0), RangeError);
});

test("随机操作：逐快照重建图核验", () => {
  for (const seed of [1, 7, 42, 2024, 987654]) {
    const rand = mulberry32(seed);
    const n = 24 + Math.floor(rand() * 24);
    const dsu = new RollbackDSU(n);
    const model = new RebuildModel(n);
    const snapshots: number[] = [];
    const ops = 3000;

    for (let step = 0; step < ops; step++) {
      const r = rand();
      if (r < 0.5) {
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        const wasConnected = model.connected(a, b);
        const merged = dsu.union(a, b);
        model.union(a, b);
        assert.equal(merged, !wasConnected, "重复合并应返回 false");
        assert.equal(dsu.opCount, model.opCount, "操作序号必须一致");
      } else if (r < 0.65) {
        snapshots.push(dsu.snapshot());
      } else if (r < 0.8 && snapshots.length > 0) {
        const idx = Math.floor(rand() * snapshots.length);
        const snap = snapshots[idx];
        dsu.rollback(snap);
        model.rollback(snap);
        for (let i = snapshots.length - 1; i >= 0; i--) {
          if (snapshots[i] > snap) snapshots.splice(i, 1);
        }
        assert.equal(dsu.opCount, model.opCount, "回滚后操作序号必须一致");
      } else {
        model.verifyAll(dsu, rand);
      }
    }
    model.verifyAll(dsu, rand);
  }
});

test("随机操作：快照套快照的嵌套回滚", () => {
  const rand = mulberry32(31337);
  const n = 32;
  const dsu = new RollbackDSU(n);
  const model = new RebuildModel(n);

  for (let round = 0; round < 200; round++) {
    const snap = dsu.snapshot();
    const inner = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < inner; i++) {
      const a = Math.floor(rand() * n);
      const b = Math.floor(rand() * n);
      dsu.union(a, b);
      model.union(a, b);
    }
    if (rand() < 0.6) {
      dsu.rollback(snap);
      model.rollback(snap);
    }
    model.verifyAll(dsu, rand);
  }
});
