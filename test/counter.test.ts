import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Counter, type State } from "../src/counter.js";

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 模拟网络传输：序列化 -> 反序列化。 */
function wire(c: Counter): State {
  return Counter.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
}

describe("基本增减", () => {
  it("增减分量累计，value 为两者之差", () => {
    const c = new Counter("a");
    c.increment(5n);
    c.increment(3n);
    c.decrement(2n);
    assert.equal(c.value(), 6n);
    assert.deepEqual(c.snapshot(), { "a#1": { inc: 8n, dec: 2n } });
  });

  it("支持负结果", () => {
    const c = new Counter("a");
    c.decrement(10n);
    c.increment(3n);
    assert.equal(c.value(), -7n);
  });

  it("拒绝负的增减量", () => {
    const c = new Counter("a");
    assert.throws(() => c.increment(-1n));
    assert.throws(() => c.decrement(-1n));
  });
});

describe("撤回（反向量追加，旧量不删）", () => {
  it("undoLast 追加反向量，分量只增不减", () => {
    const c = new Counter("a");
    c.increment(3n);
    c.increment(4n);
    assert.equal(c.undoLast(), true);
    assert.equal(c.value(), 3n);
    // 旧分量仍在：inc 保留 7，反向量计入 dec
    assert.deepEqual(c.snapshot(), { "a#1": { inc: 7n, dec: 4n } });
  });

  it("撤回可合并：反向量随状态传播到其他副本", () => {
    const a = new Counter("a");
    const b = new Counter("b");
    a.increment(10n);
    b.merge(wire(a));
    assert.equal(b.value(), 10n);
    a.undoLast();
    b.merge(wire(a));
    assert.equal(b.value(), 0n);
    assert.deepEqual(b.snapshot()["a#1"], { inc: 10n, dec: 10n });
  });

  it("空历史撤回返回 false", () => {
    const c = new Counter("a");
    assert.equal(c.undoLast(), false);
  });
});

describe("重启代际", () => {
  it("重启开启新代际，旧分量保留", () => {
    const c = new Counter("a");
    c.increment(5n);
    c.restart();
    c.increment(2n);
    assert.equal(c.generation, 2);
    assert.equal(c.value(), 7n);
    assert.deepEqual(c.snapshot(), {
      "a#1": { inc: 5n, dec: 0n },
      "a#2": { inc: 2n, dec: 0n },
    });
  });

  it("重启后旧副本的滞后状态不会覆盖新代际", () => {
    const a = new Counter("a");
    const b = new Counter("b");
    a.increment(5n);
    b.merge(wire(a)); // b 拿到 a#1
    a.restart();
    a.decrement(20n); // 写入 a#2
    b.merge(wire(a));
    assert.equal(b.value(), -15n);
    // 再次合并旧的 a#1 状态（乱序/重放），结果不变
    const stale: State = { "a#1": { inc: 5n, dec: 0n } };
    b.merge(stale);
    assert.equal(b.value(), -15n);
  });
});

describe("合并语义", () => {
  it("按分量取最大值，幂等（重复合并不变）", () => {
    const a = new Counter("a");
    const b = new Counter("b");
    a.increment(7n);
    a.decrement(1n);
    b.merge(wire(a));
    const once = b.snapshot();
    b.merge(wire(a));
    b.merge(wire(a));
    assert.deepEqual(b.snapshot(), once);
    assert.equal(b.value(), 6n);
  });

  it("交换律与结合律", () => {
    const a = new Counter("a");
    const b = new Counter("b");
    const c = new Counter("c");
    a.increment(1n);
    b.increment(2n);
    c.decrement(3n);
    const x = new Counter("x");
    x.merge(wire(a));
    x.merge(wire(b));
    x.merge(wire(c));
    const y = new Counter("y");
    y.merge(wire(c));
    y.merge(wire(a));
    y.merge(wire(b));
    const z = new Counter("z");
    z.merge(wire(a));
    const t = new Counter("t");
    t.merge(wire(b));
    t.merge(wire(c));
    z.merge(wire(t));
    assert.ok(x.equals(y));
    assert.ok(x.equals(z));
    assert.equal(x.value(), 0n);
  });
});

describe("乱序/重复合并 vs 完整操作集合求和", () => {
  // 对每个 seed：多副本随机执行 增/减/撤回/重启，
  // 再以随机顺序、含重复地互相合并（走序列化模拟网络），
  // 最终所有副本的值必须等于完整操作集合的代数和（含负结果场景）。
  for (const seed of [1, 7, 42, 2024]) {
    it(`seed=${seed} 收敛且等于操作集合求和`, () => {
      const rand = rng(seed);
      const replicaIds = ["r1", "r2", "r3", "r4"];
      const replicas = replicaIds.map((id) => new Counter(id));
      // 测试侧镜像每个副本的可撤回操作栈（有符号量）
      const stacks = new Map<string, bigint[]>(replicaIds.map((id) => [id, []]));
      let expected = 0n; // 完整操作集合的代数和（撤回 = 追加反向操作）

      const ops = 200;
      for (let i = 0; i < ops; i++) {
        const idx = Math.floor(rand() * replicas.length);
        const r = replicas[idx];
        const stack = stacks.get(r.replicaId)!;
        const kind = rand();
        if (kind < 0.4) {
          const amount = BigInt(1 + Math.floor(rand() * 20));
          r.increment(amount);
          stack.push(amount);
          expected += amount;
        } else if (kind < 0.75) {
          const amount = BigInt(1 + Math.floor(rand() * 20));
          r.decrement(amount);
          stack.push(-amount);
          expected -= amount;
        } else if (kind < 0.9) {
          if (stack.length > 0) {
            assert.equal(r.undoLast(), true);
            expected -= stack.pop()!; // 反向量：抵消被撤回的操作
          }
        } else {
          r.restart();
        }
      }

      // 乱序 + 重复合并，直到收敛
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < replicas.length; i++) {
          const dst = replicas[Math.floor(rand() * replicas.length)];
          dst.merge(wire(replicas[i]));
          dst.merge(wire(replicas[i])); // 重复合并：幂等
        }
      }
      // 最后一轮全量广播保证完全收敛
      for (const dst of replicas) {
        for (const src of replicas) dst.merge(wire(src));
      }

      for (const r of replicas) {
        assert.equal(r.value(), expected, `${r.replicaId} 的值应等于操作集合求和`);
      }
      for (let i = 1; i < replicas.length; i++) {
        assert.ok(replicas[0].equals(replicas[i]), "所有副本状态应收敛一致");
      }
    });
  }

  it("强制净负结果的场景", () => {
    const rand = rng(99);
    const a = new Counter("a");
    const b = new Counter("b");
    let expected = 0n;
    for (let i = 0; i < 50; i++) {
      const dec = BigInt(5 + Math.floor(rand() * 10));
      const inc = BigInt(1 + Math.floor(rand() * 3));
      a.decrement(dec);
      b.increment(inc);
      expected += inc - dec;
    }
    assert.ok(expected < 0n);
    a.merge(wire(b));
    b.merge(wire(a));
    assert.equal(a.value(), expected);
    assert.equal(b.value(), expected);
    assert.ok(a.value() < 0n);
  });
});
