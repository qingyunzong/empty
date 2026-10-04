import { ORSet, type Message } from "../src/index.js";

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 把消息以随机顺序投递给每个目标副本，并以约 1/3 概率重复投递（模拟乱序+重复网络）。 */
export function deliverShuffled<T>(
  messages: readonly Message<T>[],
  targets: readonly ORSet<T>[],
  rand: () => number,
): void {
  for (const target of targets) {
    for (const msg of shuffled(messages, rand)) {
      target.apply(msg);
      if (rand() < 1 / 3) target.apply(msg);
    }
  }
}

/** 全副本互发确认向量并互相投递。 */
export function syncAcks<T>(replicas: readonly ORSet<T>[]): void {
  const acks = replicas.map((r) => r.ack());
  for (const replica of replicas) {
    for (const ack of acks) replica.apply(ack);
  }
}

/** 全副本两两做状态合并（并集），用于全同步场景。 */
export function syncMerge<T>(replicas: readonly ORSet<T>[]): void {
  for (const a of replicas) {
    for (const b of replicas) {
      if (a !== b) a.merge(b);
    }
  }
}

export function sortedValues(set: ORSet<string>): string[] {
  return [...set.values()].sort();
}
