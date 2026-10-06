/**
 * 因果广播模拟库。
 *
 * 交付规则：
 *  - 每条消息携带 (source, seq) 每源序号与 deps 依赖向量（向量时钟）。
 *  - 仅当某源序号连续（前驱均已交付或被水位覆盖）且依赖向量全部满足时才交付；
 *    否则暂存，待因果前驱到达后按因果序级联交付。
 *  - 同 ID 同内容视为重复，幂等忽略；同 ID 异内容（或同源同序号异 ID）拒绝。
 *  - 水位 declareWatermark(source, k) 声明该源 seq <= k 的消息不会再到达：
 *    之后到达的旧消息被拒绝；序号空洞与依赖缺口视为已被水位覆盖而放行。
 */

export type NodeId = string;

/** 依赖向量：source -> 交付该消息前必须已交付的该源最大序号 */
export type VectorClock = Record<NodeId, number>;

export interface Message<C = unknown> {
  id: string;
  source: NodeId;
  seq: number;
  deps: VectorClock;
  content: C;
}

export type PendingReason =
  | { kind: 'missing-predecessor'; source: NodeId; expectedSeq: number }
  | { kind: 'missing-dependency'; source: NodeId; requiredSeq: number; deliveredSeq: number };

export type RejectReason =
  | { kind: 'invalid-sequence'; id: string; seq: number }
  | { kind: 'conflicting-duplicate'; id: string }
  | { kind: 'conflicting-sequence'; source: NodeId; seq: number; existingId: string }
  | { kind: 'below-watermark'; source: NodeId; seq: number; watermark: number };

export type ReceiveResult<C = unknown> =
  | { status: 'delivered'; delivered: Message<C>[] }
  | { status: 'buffered'; reasons: PendingReason[] }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: RejectReason };

export interface PendingEntry<C = unknown> {
  id: string;
  message: Message<C>;
  reasons: PendingReason[];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    return ak.length === bk.length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}

function vectorEqual(a: VectorClock, b: VectorClock): boolean {
  const ak = Object.keys(a).filter((k) => a[k] !== 0);
  const bk = Object.keys(b).filter((k) => b[k] !== 0);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}

export class CausalBroadcast<C = unknown> {
  /** 每源已连续交付的最大序号 */
  private readonly deliveredSeq = new Map<NodeId, number>();
  /** 每源水位：seq <= 水位的消息保证不会再到达 */
  private readonly watermarks = new Map<NodeId, number>();
  /** 已见消息（含已交付与暂存），按 id */
  private readonly seenById = new Map<string, Message<C>>();
  /** `source:seq` -> id，用于检测同源同序号异 ID 冲突 */
  private readonly seenBySeq = new Map<string, string>();
  /** 暂存区：因果前驱未到的消息 */
  private readonly buffer = new Map<string, Message<C>>();
  /** 交付日志（因果序） */
  private readonly deliveryLog: Message<C>[] = [];

  private deliveredOf(source: NodeId): number {
    return this.deliveredSeq.get(source) ?? 0;
  }

  private watermarkOf(source: NodeId): number {
    return this.watermarks.get(source) ?? 0;
  }

  /** 门控下限：已交付序号与水位共同覆盖到的序号 */
  private floorOf(source: NodeId): number {
    return Math.max(this.deliveredOf(source), this.watermarkOf(source));
  }

  /** 计算一条消息当前不可交付的全部原因；为空数组表示可交付 */
  private blockersOf(msg: Message<C>): PendingReason[] {
    const reasons: PendingReason[] = [];
    const floor = this.floorOf(msg.source);
    if (msg.seq > floor + 1) {
      reasons.push({
        kind: 'missing-predecessor',
        source: msg.source,
        expectedSeq: floor + 1,
      });
    }
    for (const [depSource, requiredSeq] of Object.entries(msg.deps)) {
      if (depSource === msg.source && requiredSeq < msg.seq) continue; // 自身前驱由序号规则覆盖
      if (this.floorOf(depSource) < requiredSeq) {
        reasons.push({
          kind: 'missing-dependency',
          source: depSource,
          requiredSeq,
          deliveredSeq: this.deliveredOf(depSource),
        });
      }
    }
    return reasons;
  }

  /**
   * 接收一条消息。
   * 返回 delivered 时附带本次级联交付的全部消息（含自身，按交付顺序）。
   */
  receive(msg: Message<C>): ReceiveResult<C> {
    if (!Number.isInteger(msg.seq) || msg.seq < 1) {
      return { status: 'rejected', reason: { kind: 'invalid-sequence', id: msg.id, seq: msg.seq } };
    }

    const prior = this.seenById.get(msg.id);
    if (prior !== undefined) {
      const identical =
        prior.source === msg.source &&
        prior.seq === msg.seq &&
        vectorEqual(prior.deps, msg.deps) &&
        deepEqual(prior.content, msg.content);
      return identical
        ? { status: 'duplicate' }
        : { status: 'rejected', reason: { kind: 'conflicting-duplicate', id: msg.id } };
    }

    const watermark = this.watermarkOf(msg.source);
    if (msg.seq <= watermark) {
      return {
        status: 'rejected',
        reason: { kind: 'below-watermark', source: msg.source, seq: msg.seq, watermark },
      };
    }

    const seqKey = `${msg.source}:${msg.seq}`;
    const existingId = this.seenBySeq.get(seqKey);
    if (existingId !== undefined) {
      return {
        status: 'rejected',
        reason: {
          kind: 'conflicting-sequence',
          source: msg.source,
          seq: msg.seq,
          existingId,
        },
      };
    }

    this.seenById.set(msg.id, msg);
    this.seenBySeq.set(seqKey, msg.id);
    this.buffer.set(msg.id, msg);

    const delivered = this.cascade();
    if (delivered.some((m) => m.id === msg.id)) {
      return { status: 'delivered', delivered };
    }
    return { status: 'buffered', reasons: this.blockersOf(msg) };
  }

  /**
   * 水位声明：source 保证 seq <= k 的消息不会再到达。
   * 之后到达的 seq <= k 消息被拒绝；被空洞阻塞的后续消息按水位放行。
   * 返回因此级联交付的消息。
   */
  declareWatermark(source: NodeId, seq: number): Message<C>[] {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new RangeError(`invalid watermark seq: ${seq}`);
    }
    const current = this.watermarkOf(source);
    if (seq > current) {
      this.watermarks.set(source, seq);
    }
    return this.cascade();
  }

  /** 暂存区中全部消息及其待决原因 */
  pending(): PendingEntry<C>[] {
    return [...this.buffer.values()].map((message) => ({
      id: message.id,
      message,
      reasons: this.blockersOf(message),
    }));
  }

  /** 单条暂存消息的待决原因；未暂存时返回 null */
  pendingReasons(id: string): PendingReason[] | null {
    const msg = this.buffer.get(id);
    return msg === undefined ? null : this.blockersOf(msg);
  }

  /** 已交付消息日志（交付顺序即一种因果线性化） */
  delivered(): readonly Message<C>[] {
    return this.deliveryLog;
  }

  isDelivered(id: string): boolean {
    const msg = this.seenById.get(id);
    return msg !== undefined && !this.buffer.has(id);
  }

  deliveredSeqOf(source: NodeId): number {
    return this.deliveredOf(source);
  }

  watermarkOfSource(source: NodeId): number {
    return this.watermarkOf(source);
  }

  /** 扫描暂存区，交付所有因果就绪的消息，直到不动点 */
  private cascade(): Message<C>[] {
    const newlyDelivered: Message<C>[] = [];
    for (;;) {
      let ready: Message<C> | undefined;
      for (const msg of this.buffer.values()) {
        if (this.blockersOf(msg).length === 0) {
          ready = msg;
          break;
        }
      }
      if (ready === undefined) break;
      this.buffer.delete(ready.id);
      const prev = this.deliveredOf(ready.source);
      if (ready.seq > prev) {
        this.deliveredSeq.set(ready.source, ready.seq);
      }
      this.deliveryLog.push(ready);
      newlyDelivered.push(ready);
    }
    return newlyDelivered;
  }
}
