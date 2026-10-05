import type { Replica } from "./store.js";

/** 确定性伪随机数（mulberry32），让乱序投递可复现。 */
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

/** 同步网络：在副本间投递操作日志（可乱序）并交换确认向量。 */
export class SyncNetwork {
  private readonly replicas: Replica[] = [];

  connect(...replicas: Replica[]): void {
    for (const replica of replicas) {
      for (const peer of this.replicas) {
        replica.knowPeer(peer.id);
        peer.knowPeer(replica.id);
      }
      if (!this.replicas.includes(replica)) this.replicas.push(replica);
    }
  }

  /** 一轮同步：互投日志（shuffle 时按种子乱序），随后互发确认。 */
  sync(options: { shuffle?: boolean; seed?: number } = {}): void {
    const random = mulberry32(options.seed ?? 1);
    for (const source of this.replicas) {
      for (const target of this.replicas) {
        if (target === source) continue;
        const ops = [...source.log];
        if (options.shuffle) {
          for (let i = ops.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [ops[i], ops[j]] = [ops[j]!, ops[i]!];
          }
        }
        for (const op of ops) target.apply(op);
      }
    }
    for (const source of this.replicas) {
      for (const target of this.replicas) {
        if (target === source) continue;
        target.acknowledge(source.id, source.vector);
      }
    }
  }
}
