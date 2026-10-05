import { test } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityMonitor } from "../src/monitor.js";
import { TickModel } from "../src/tickModel.js";
import { covers } from "../src/intervals.js";

/** 确定性伪随机数（mulberry32），保证失败可复现。 */
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

const SERVICES = ["s0", "s1", "s2", "s3", "s4"];
const T_MAX = 24;

function randomScenario(seed: number): AvailabilityMonitor {
  const rand = rng(seed);
  const m = new AvailabilityMonitor();
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const span = (): [number, number] => {
    const a = Math.floor(rand() * (T_MAX - 1));
    const b = a + 1 + Math.floor(rand() * (T_MAX - a - 1));
    return [a, b];
  };
  const ops = 12 + Math.floor(rand() * 10);
  for (let i = 0; i < ops; i++) {
    const s = pick(SERVICES);
    const r = rand();
    if (r < 0.45) {
      const [a, b] = span();
      m.addInterval(s, a, b);
    } else if (r < 0.7) {
      const [a, b] = span();
      m.removeInterval(s, a, b);
    } else if (r < 0.88) {
      const d = pick(SERVICES);
      m.addDependency(s, d);
    } else {
      const deps = m.dependencies(s);
      if (deps.length > 0) m.removeDependency(s, pick(deps));
    }
  }
  return m;
}

for (const seed of [1, 7, 42, 1337, 20261005, 999983]) {
  test(`随机增删区间与依赖（seed=${seed}）：扫描线对照逐 tick 图闭包`, () => {
    const m = randomScenario(seed);
    const tick = new TickModel(m);
    for (const k of [1, 2, 3]) {
      assert.deepEqual(
        m.compute(k),
        tick.segments(k, 0, T_MAX),
        `k=${k} 段不一致`,
      );
    }
    // 全来源证据：逐 tick 的每服务可用判定与有效区间覆盖一致
    const eff = m.effectiveIntervals();
    for (let t = 0; t < T_MAX; t++) {
      for (const [s, ev] of tick.evidence(t)) {
        assert.equal(
          covers(eff.get(s) ?? [], t),
          ev.available,
          `t=${t} 服务 ${s} 证据与有效区间不符`,
        );
      }
    }
  });
}

test("逐 tick 证据可解释循环依赖：环成员同生同灭", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("x", 0, 10);
  m.addInterval("y", 4, 10);
  m.addDependency("x", "y");
  m.addDependency("y", "x");
  const tick = new TickModel(m);
  for (let t = 0; t < 12; t++) {
    const ev = tick.evidence(t);
    const x = ev.get("x")!;
    const y = ev.get("y")!;
    assert.equal(x.available, y.available, `t=${t} 环成员判定应一致`);
    assert.equal(x.available, t >= 4 && t < 10, `t=${t} 环只有全成员在线才可用`);
    assert.equal(x.online, t < 10);
    assert.equal(y.online, t >= 4 && t < 10);
  }
});
