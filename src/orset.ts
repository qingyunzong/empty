import { VectorClock, type VectorClockData } from "./vector-clock.js";

/** 添加消息：携带全局唯一 tag 与发送者确认向量。 */
export interface AddMessage<T> {
  readonly kind: "add";
  readonly from: string;
  readonly seq: number;
  readonly tag: string;
  readonly value: T;
  readonly clock: VectorClockData;
}

/** 删除消息：只列出删除发起时本副本观察到的 tag（observed-remove）。 */
export interface RemoveMessage {
  readonly kind: "remove";
  readonly from: string;
  readonly key: string;
  readonly tags: readonly string[];
  readonly clock: VectorClockData;
}

/** 确认消息：纯心跳，传播发送者的确认向量。 */
export interface AckMessage {
  readonly kind: "ack";
  readonly from: string;
  readonly clock: VectorClockData;
}

export type Message<T> = AddMessage<T> | RemoveMessage | AckMessage;

/** 可序列化的状态快照，用于持久化恢复或新副本加入。 */
export interface ORSetSnapshot<T> {
  readonly replicaId: string;
  readonly seq: number;
  readonly entries: ReadonlyArray<readonly [string, T]>;
  readonly tombstones: readonly string[];
  readonly clock: VectorClockData;
  readonly acks: ReadonlyArray<readonly [string, VectorClockData]>;
}

const TAG_SEPARATOR = ":";

export function makeTag(replicaId: string, seq: number): string {
  return `${replicaId}${TAG_SEPARATOR}${seq}`;
}

export function parseTag(tag: string): { origin: string; seq: number } {
  const idx = tag.lastIndexOf(TAG_SEPARATOR);
  return { origin: tag.slice(0, idx), seq: Number(tag.slice(idx + 1)) };
}

function defaultKey(value: unknown): string {
  return typeof value === "string" ? `s:${value}` : JSON.stringify(value) ?? String(value);
}

/**
 * 离线集合（OR-Set CRDT，observed-remove 语义）：
 * - 每次 add 生成全局唯一 tag（replicaId:seq）；
 * - remove 只移除发起时本地观察到的 tag，并发/未见的添加存活（add-wins）；
 * - merge 为并集：存活条目与墓碑分别取并，墓碑优先；
 * - compact 只有在"全部已知副本的确认向量都覆盖某 tag 的添加事件"后才回收其墓碑。
 *
 * 假设（与常规 CRDT 压缩一致）：副本间采用带确认的可靠广播——
 * 未被确认的消息可能乱序或重复投递；已被全副本确认的事件不会再被重发。
 */
export class ORSet<T> {
  readonly replicaId: string;
  private readonly keyOf: (value: T) => string;
  private seq = 0;
  /** 本副本实际观察到的事件（连续前缀）。 */
  private readonly clock = new VectorClock();
  /** 存活条目：tag -> value。 */
  private readonly entries = new Map<string, T>();
  /** 墓碑：已被删除的 tag，用于吞掉晚到/重放的对应添加。 */
  private readonly tombstones = new Set<string>();
  /** 每个副本最近一次通告的确认向量；自己的确认向量即本地时钟。 */
  private readonly acks = new Map<string, VectorClock>();
  /** 乱序添加的缓冲：origin -> (seq -> 消息)，等待前驱到达。 */
  private readonly pending = new Map<string, Map<number, AddMessage<T>>>();

  constructor(replicaId: string, keyOf: (value: T) => string = defaultKey) {
    this.replicaId = replicaId;
    this.keyOf = keyOf;
    this.acks.set(replicaId, this.clock);
  }

  /** 本地添加：生成唯一 tag，返回待广播的消息。 */
  add(value: T): AddMessage<T> {
    this.seq += 1;
    const tag = makeTag(this.replicaId, this.seq);
    this.clock.advanceTo(this.replicaId, this.seq);
    this.entries.set(tag, value);
    return {
      kind: "add",
      from: this.replicaId,
      seq: this.seq,
      tag,
      value,
      clock: this.clock.toJSON(),
    };
  }

  /** 本地删除：只移除当前观察到的该值的全部 tag；未观察到任何 tag 时返回 null。 */
  remove(value: T): RemoveMessage | null {
    const key = this.keyOf(value);
    const tags: string[] = [];
    for (const [tag, entry] of this.entries) {
      if (this.keyOf(entry) === key) tags.push(tag);
    }
    if (tags.length === 0) return null;
    for (const tag of tags) {
      this.entries.delete(tag);
      this.tombstones.add(tag);
    }
    return {
      kind: "remove",
      from: this.replicaId,
      key,
      tags,
      clock: this.clock.toJSON(),
    };
  }

  /** 生成确认消息（心跳），用于向其他副本通告自己的观察进度。 */
  ack(): AckMessage {
    return { kind: "ack", from: this.replicaId, clock: this.clock.toJSON() };
  }

  /** 应用远端消息：幂等、与顺序无关（乱序添加会被缓冲）。 */
  apply(msg: Message<T>): void {
    this.recordAck(msg.from, msg.clock);
    switch (msg.kind) {
      case "add":
        this.applyAdd(msg);
        break;
      case "remove":
        for (const tag of msg.tags) {
          this.entries.delete(tag);
          this.tombstones.add(tag);
        }
        break;
      case "ack":
        break;
    }
  }

  /** 状态合并（并集）：条目与墓碑分别取并，墓碑优先；时钟与确认向量取分量最大值。 */
  merge(other: ORSet<T>): void {
    for (const [tag, value] of other.entries) {
      if (!this.tombstones.has(tag)) this.entries.set(tag, value);
    }
    for (const tag of other.tombstones) {
      this.tombstones.add(tag);
      this.entries.delete(tag);
    }
    this.clock.merge(other.clock);
    for (const [replica, clock] of other.acks) {
      if (replica === this.replicaId) continue;
      const known = this.acks.get(replica);
      if (known) known.merge(clock);
      else this.acks.set(replica, clock.clone());
    }
  }

  /**
   * 压缩：回收"全部已知副本的确认向量均已覆盖其添加事件"的墓碑。
   * 返回被回收的 tag。确认未收齐的墓碑一律保留。
   */
  compact(): string[] {
    const replicas = [...this.acks.keys()];
    const collected: string[] = [];
    for (const tag of this.tombstones) {
      const { origin, seq } = parseTag(tag);
      const confirmed = replicas.every((r) => (this.acks.get(r)?.get(origin) ?? 0) >= seq);
      if (confirmed) {
        this.tombstones.delete(tag);
        collected.push(tag);
      }
    }
    return collected;
  }

  /** 登记一个必须参与确认的副本（如已知但暂时离线的成员），其确认未到达前会阻止压缩。 */
  trackReplica(replicaId: string): void {
    if (!this.acks.has(replicaId)) {
      this.acks.set(replicaId, new VectorClock());
    }
  }

  values(): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const value of this.entries.values()) {
      const key = this.keyOf(value);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(value);
      }
    }
    return out;
  }

  has(value: T): boolean {
    const key = this.keyOf(value);
    for (const entry of this.entries.values()) {
      if (this.keyOf(entry) === key) return true;
    }
    return false;
  }

  get size(): number {
    return this.values().length;
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get tombstoneCount(): number {
    return this.tombstones.size;
  }

  get pendingCount(): number {
    let count = 0;
    for (const buffer of this.pending.values()) count += buffer.size;
    return count;
  }

  clockData(): Record<string, number> {
    return this.clock.toJSON();
  }

  /** 数据层面对等比较（条目、墓碑、观察时钟），用于收敛校验。 */
  equals(other: ORSet<T>): boolean {
    if (this.entries.size !== other.entries.size) return false;
    if (this.tombstones.size !== other.tombstones.size) return false;
    for (const [tag, value] of this.entries) {
      const otherValue = other.entries.get(tag);
      if (otherValue === undefined || this.keyOf(otherValue) !== this.keyOf(value)) return false;
    }
    for (const tag of this.tombstones) {
      if (!other.tombstones.has(tag)) return false;
    }
    return this.clock.equals(other.clock);
  }

  snapshot(): ORSetSnapshot<T> {
    return {
      replicaId: this.replicaId,
      seq: this.seq,
      entries: [...this.entries],
      tombstones: [...this.tombstones],
      clock: this.clock.toJSON(),
      acks: [...this.acks].map(([replica, clock]) => [replica, clock.toJSON()] as const),
    };
  }

  /** 从快照恢复（同一 replicaId，持久化场景）。 */
  static restore<T>(snapshot: ORSetSnapshot<T>, keyOf?: (value: T) => string): ORSet<T> {
    const set = new ORSet<T>(snapshot.replicaId, keyOf);
    set.seq = snapshot.seq;
    for (const [tag, value] of snapshot.entries) set.entries.set(tag, value);
    for (const tag of snapshot.tombstones) set.tombstones.add(tag);
    set.clock.merge(VectorClock.from(snapshot.clock));
    for (const [replica, data] of snapshot.acks) {
      if (replica === set.replicaId) continue;
      set.acks.set(replica, VectorClock.from(data));
    }
    return set;
  }

  private recordAck(from: string, clockData: VectorClockData): void {
    const known = this.acks.get(from);
    if (known) known.merge(VectorClock.from(clockData));
    else this.acks.set(from, VectorClock.from(clockData));
  }

  private applyAdd(msg: AddMessage<T>): void {
    const origin = msg.from;
    const seen = this.clock.get(origin);
    if (msg.seq <= seen) return; // 重复消息：此前已按序应用过，幂等忽略
    if (msg.seq > seen + 1) {
      // 乱序：前驱事件尚未到达，先缓冲
      let buffer = this.pending.get(origin);
      if (!buffer) {
        buffer = new Map();
        this.pending.set(origin, buffer);
      }
      buffer.set(msg.seq, msg);
      return;
    }
    this.applyAddNow(msg);
    // 前驱齐了，排空缓冲中的后续事件
    const buffer = this.pending.get(origin);
    if (buffer) {
      let next = this.clock.get(origin) + 1;
      while (buffer.has(next)) {
        this.applyAddNow(buffer.get(next)!);
        buffer.delete(next);
        next += 1;
      }
      if (buffer.size === 0) this.pending.delete(origin);
    }
  }

  private applyAddNow(msg: AddMessage<T>): void {
    this.clock.advanceTo(msg.from, msg.seq);
    if (this.tombstones.has(msg.tag)) return; // 删除先于添加到达：墓碑吞掉该添加
    this.entries.set(msg.tag, msg.value);
  }
}
