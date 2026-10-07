import { Ack, Probe } from "./types";

interface InFlight {
  deliverAt: number;
  /** 同刻投递时的稳定次序 */
  order: number;
  ack: Ack;
}

/**
 * 模拟网络：节点收到探测即应答，但回包经过随机延迟后投递，
 * 因此先发的探测可能后到（重排）。延迟由注入的 RNG 决定，可复现。
 */
export class SimulatedNetwork {
  private queue: InFlight[] = [];
  private counter = 0;

  constructor(
    private readonly rng: () => number,
    private readonly maxDelay: number = 5,
  ) {
    if (!(maxDelay >= 1)) {
      throw new Error("maxDelay must be >= 1");
    }
  }

  /** 发送探测；节点立即应答，回包在 now + [1, maxDelay] 的随机延迟后投递。 */
  send(probe: Probe, now: number): number {
    const delay = 1 + Math.floor(this.rng() * this.maxDelay);
    const deliverAt = now + delay;
    this.queue.push({
      deliverAt,
      order: this.counter++,
      ack: { nodeId: probe.nodeId, seq: probe.seq, generation: probe.generation },
    });
    return deliverAt;
  }

  /** 取出所有 deliverAt <= now 的回包，按 (投递时刻, 入队次序) 排序。 */
  deliverDue(now: number): Ack[] {
    const due = this.queue
      .filter((entry) => entry.deliverAt <= now)
      .sort((a, b) => a.deliverAt - b.deliverAt || a.order - b.order);
    this.queue = this.queue.filter((entry) => entry.deliverAt > now);
    return due.map((entry) => entry.ack);
  }

  get pending(): number {
    return this.queue.length;
  }
}
