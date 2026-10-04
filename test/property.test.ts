import { test } from "node:test";
import assert from "node:assert/strict";
import { StateSequence, type Sample } from "../src/state-sequence.js";
import { TickInterpreter } from "./tick-interpreter.js";

/** mulberry32 确定性伪随机数发生器 */
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

const DOMAIN = 240; // tick 取值范围 [0, DOMAIN)
const VALUES = ["a", "b", "c", "d"];

function randomSample(rand: () => number): Sample<string> {
  const sample: { t: number; version: number; value: string; ttl?: number } = {
    t: Math.floor(rand() * DOMAIN),
    version: Math.floor(rand() * 4),
    value: VALUES[Math.floor(rand() * VALUES.length)]!,
  };
  if (rand() < 0.5) sample.ttl = 1 + Math.floor(rand() * 24);
  return sample;
}

test("随机插入/删除与逐 tick 解释器逐步核对", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    const seq = new StateSequence<string>();
    const ref = new TickInterpreter<string>();

    for (let step = 0; step < 400; step++) {
      if (rand() < 0.7) {
        const sample = randomSample(rand);
        assert.equal(
          seq.insert(sample),
          ref.insert(sample),
          `seed=${seed} step=${step} insert 返回值不一致: ${JSON.stringify(sample)}`,
        );
      } else {
        const t = Math.floor(rand() * DOMAIN);
        assert.equal(seq.delete(t), ref.delete(t), `seed=${seed} step=${step} delete(${t}) 返回值不一致`);
      }

      // 每步都抽查若干 tick 的点值
      for (let k = 0; k < 8; k++) {
        const tick = Math.floor(rand() * DOMAIN);
        assert.equal(seq.at(tick), ref.valueAt(tick), `seed=${seed} step=${step} at(${tick})`);
      }

      // 周期性做全范围段比对 + 随机子区间比对
      if (step % 25 === 0) {
        assert.deepEqual(seq.query(0, DOMAIN), ref.interpret(0, DOMAIN), `seed=${seed} step=${step} 全范围`);
        const a = Math.floor(rand() * DOMAIN);
        const b = Math.floor(rand() * DOMAIN);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        assert.deepEqual(seq.query(lo, hi), ref.interpret(lo, hi), `seed=${seed} step=${step} query(${lo}, ${hi})`);
      }
    }

    // 收尾：全范围 + 每个 tick 点值终检
    assert.deepEqual(seq.query(0, DOMAIN), ref.interpret(0, DOMAIN), `seed=${seed} 终检`);
    for (let tick = 0; tick < DOMAIN; tick++) {
      assert.equal(seq.at(tick), ref.valueAt(tick), `seed=${seed} 终检 at(${tick})`);
    }
  }
});

test("密集同时间更正（版本竞争）与解释器一致", () => {
  const rand = rng(0xc0ffee);
  const seq = new StateSequence<string>();
  const ref = new TickInterpreter<string>();
  for (let i = 0; i < 3000; i++) {
    const sample: Sample<string> = {
      t: Math.floor(rand() * 8), // 仅 8 个时间戳，制造大量同时间更正
      version: Math.floor(rand() * 6),
      value: VALUES[Math.floor(rand() * VALUES.length)]!,
      ...(rand() < 0.4 ? { ttl: 1 + Math.floor(rand() * 10) } : {}),
    };
    assert.equal(seq.insert(sample), ref.insert(sample), `i=${i}`);
  }
  assert.deepEqual(seq.query(0, DOMAIN), ref.interpret(0, DOMAIN));
});
