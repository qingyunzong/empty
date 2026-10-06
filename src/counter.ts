/**
 * CRDT 计数器（PN-Counter 变体）。
 *
 * - 每个副本的每个代际维护一对增减分量（inc / dec），分量只增不减。
 * - 合并按分量取最大值，满足交换律、结合律、幂等律。
 * - 撤回（undo）通过追加反向量实现，旧分量永不删除。
 * - 副本重启（restart）开启新代际，旧代际分量保留并参与合并。
 * - 所有整数运算使用 bigint。
 */

export interface Component {
  inc: bigint;
  dec: bigint;
}

/** 分量键：`${replicaId}#${generation}` */
export type ComponentKey = string;

/** 深拷贝出的状态快照（bigint 形式） */
export type State = Record<ComponentKey, Component>;

/** JSON 可序列化的状态（bigint 以十进制字符串表示） */
export type SerializedState = Record<ComponentKey, { inc: string; dec: string }>;

interface Op {
  field: "inc" | "dec";
  amount: bigint;
}

export class Counter {
  readonly replicaId: string;
  #generation: number;
  #components = new Map<ComponentKey, Component>();
  /** 本地可撤回操作的历史（仅 increment/decrement，不含反向量） */
  #history: Op[] = [];

  constructor(replicaId: string, generation = 1) {
    if (replicaId.length === 0) throw new Error("replicaId must be non-empty");
    if (!Number.isInteger(generation) || generation < 1) {
      throw new RangeError("generation must be a positive integer");
    }
    this.replicaId = replicaId;
    this.#generation = generation;
  }

  get generation(): number {
    return this.#generation;
  }

  /** 当前状态中的分量数量（键 = 副本#代际） */
  get size(): number {
    return this.#components.size;
  }

  get #key(): ComponentKey {
    return `${this.replicaId}#${this.#generation}`;
  }

  #component(key: ComponentKey): Component {
    let c = this.#components.get(key);
    if (c === undefined) {
      c = { inc: 0n, dec: 0n };
      this.#components.set(key, c);
    }
    return c;
  }

  #apply(field: "inc" | "dec", amount: bigint): void {
    if (amount < 0n) throw new RangeError("amount must be >= 0");
    if (amount === 0n) return;
    this.#component(this.#key)[field] += amount;
    this.#history.push({ field, amount });
  }

  increment(amount = 1n): void {
    this.#apply("inc", amount);
  }

  decrement(amount = 1n): void {
    this.#apply("dec", amount);
  }

  /**
   * 撤回最近一次本地操作：把该操作的反向量追加到当前代际的分量上。
   * 旧分量保持不变（只增语义），因此撤回本身也是可合并的增量操作。
   * 返回 false 表示没有可撤回的本地操作。
   */
  undoLast(): boolean {
    const op = this.#history.pop();
    if (op === undefined) return false;
    const inverseField = op.field === "inc" ? "dec" : "inc";
    this.#component(this.#key)[inverseField] += op.amount;
    return true;
  }

  /** 重启副本：开启新代际，后续操作写入新分量；旧分量全部保留。 */
  restart(): number {
    this.#generation += 1;
    return this.#generation;
  }

  /** 当前值 = 所有分量的 inc 之和减去 dec 之和（可为负）。 */
  value(): bigint {
    let sum = 0n;
    for (const c of this.#components.values()) {
      sum += c.inc - c.dec;
    }
    return sum;
  }

  /** 深拷贝的状态快照。 */
  snapshot(): State {
    const out: State = {};
    for (const [key, c] of this.#components) {
      out[key] = { inc: c.inc, dec: c.dec };
    }
    return out;
  }

  /** 按分量取最大值合并（幂等、可交换、可结合）。 */
  merge(source: Counter | State): void {
    const state = source instanceof Counter ? source.snapshot() : source;
    for (const [key, c] of Object.entries(state)) {
      const local = this.#component(key);
      if (c.inc > local.inc) local.inc = c.inc;
      if (c.dec > local.dec) local.dec = c.dec;
    }
  }

  equals(other: Counter): boolean {
    const a = this.snapshot();
    const b = other.snapshot();
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const x = a[key] ?? { inc: 0n, dec: 0n };
      const y = b[key] ?? { inc: 0n, dec: 0n };
      if (x.inc !== y.inc || x.dec !== y.dec) return false;
    }
    return true;
  }

  toJSON(): SerializedState {
    const out: SerializedState = {};
    for (const [key, c] of this.#components) {
      out[key] = { inc: c.inc.toString(), dec: c.dec.toString() };
    }
    return out;
  }

  /** 把序列化状态还原为可合并的 State（传输后用于 merge）。 */
  static fromJSON(json: SerializedState): State {
    const out: State = {};
    for (const [key, c] of Object.entries(json)) {
      out[key] = { inc: BigInt(c.inc), dec: BigInt(c.dec) };
    }
    return out;
  }
}
