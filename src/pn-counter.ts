/**
 * PN-Counter CRDT。
 *
 * - 每个副本的每一代际维护一对只增分量：inc（增量）与 dec（减量）。
 * - 合并时对每个 (replicaId, generation) 的 inc/dec 分别取最大值，
 *   满足交换律、结合律、幂等，乱序/重复合并收敛。
 * - 撤回通过新增反向量实现（撤 increment 就追加等量 dec），
 *   旧分量只增不减，绝不删除。
 * - 副本重启进入新代际：旧代际分量原样保留，新代际从零累计。
 * - 所有计数均为 bigint，可表示任意精度整数（含负结果）。
 */

export interface CounterComponent {
  inc: bigint;
  dec: bigint;
}

/** JSON 安全的快照形式（bigint 以十进制字符串表示）。 */
export type CounterSnapshot = Record<string, { inc: string; dec: string }>;

export class PNCounter {
  private readonly components = new Map<string, CounterComponent>();

  constructor(
    readonly replicaId: string,
    private generation = 1,
  ) {
    this.currentComponent();
  }

  static componentKey(replicaId: string, generation: number): string {
    return `${replicaId}#${generation}`;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  private currentComponent(): CounterComponent {
    const key = PNCounter.componentKey(this.replicaId, this.generation);
    let component = this.components.get(key);
    if (component === undefined) {
      component = { inc: 0n, dec: 0n };
      this.components.set(key, component);
    }
    return component;
  }

  private static assertPositive(amount: bigint): void {
    if (amount <= 0n) {
      throw new RangeError(`amount must be a positive bigint, got ${amount}`);
    }
  }

  increment(amount: bigint = 1n): void {
    PNCounter.assertPositive(amount);
    this.currentComponent().inc += amount;
  }

  decrement(amount: bigint = 1n): void {
    PNCounter.assertPositive(amount);
    this.currentComponent().dec += amount;
  }

  /** 撤回一笔增量：新增等量反向量（dec），不删改旧的 inc。 */
  undoIncrement(amount: bigint = 1n): void {
    this.decrement(amount);
  }

  /** 撤回一笔减量：新增等量反向量（inc），不删改旧的 dec。 */
  undoDecrement(amount: bigint = 1n): void {
    this.increment(amount);
  }

  /** 副本重启：代际 +1，旧代际分量保留，新代际分量从零开始。 */
  restart(): void {
    this.generation += 1;
    this.currentComponent();
  }

  /** 当前计数值：所有 (副本, 代际) 分量的 inc - dec 之和。 */
  value(): bigint {
    let sum = 0n;
    for (const component of this.components.values()) {
      sum += component.inc - component.dec;
    }
    return sum;
  }

  /** 合并：对每个 (副本, 代际) 的 inc/dec 分别取最大。幂等。 */
  merge(other: PNCounter): void {
    for (const [key, remote] of other.components) {
      const local = this.components.get(key);
      if (local === undefined) {
        this.components.set(key, { inc: remote.inc, dec: remote.dec });
      } else {
        if (remote.inc > local.inc) local.inc = remote.inc;
        if (remote.dec > local.dec) local.dec = remote.dec;
      }
    }
  }

  /** 只读查看某副本某代际的分量（不存在则返回 undefined）。 */
  componentOf(replicaId: string, generation: number): CounterComponent | undefined {
    const component = this.components.get(PNCounter.componentKey(replicaId, generation));
    return component === undefined ? undefined : { ...component };
  }

  /** 已知的所有 (副本#代际) 分量键。 */
  componentKeys(): string[] {
    return [...this.components.keys()];
  }

  clone(): PNCounter {
    const copy = new PNCounter(this.replicaId, this.generation);
    copy.components.clear();
    for (const [key, component] of this.components) {
      copy.components.set(key, { ...component });
    }
    return copy;
  }

  snapshot(): CounterSnapshot {
    const snapshot: CounterSnapshot = {};
    for (const [key, component] of this.components) {
      snapshot[key] = { inc: component.inc.toString(), dec: component.dec.toString() };
    }
    return snapshot;
  }

  static fromSnapshot(replicaId: string, generation: number, snapshot: CounterSnapshot): PNCounter {
    const counter = new PNCounter(replicaId, generation);
    counter.components.clear();
    for (const [key, component] of Object.entries(snapshot)) {
      counter.components.set(key, { inc: BigInt(component.inc), dec: BigInt(component.dec) });
    }
    return counter;
  }
}
