/**
 * 向量时钟：记录"本副本实际观察到的事件"，按副本连续前缀计数。
 * 每个副本的事件序号从 1 开始严格递增，因此 clock[r] = n 表示
 * 已按顺序观察到副本 r 的 1..n 全部事件（乱序消息会被缓冲，见 ORSet）。
 */
export type VectorClockData = Readonly<Record<string, number>>;

export class VectorClock {
  private readonly entries = new Map<string, number>();

  static from(data: VectorClockData): VectorClock {
    const clock = new VectorClock();
    for (const [replica, seq] of Object.entries(data)) {
      clock.advanceTo(replica, seq);
    }
    return clock;
  }

  get(replica: string): number {
    return this.entries.get(replica) ?? 0;
  }

  advanceTo(replica: string, seq: number): void {
    if (seq > this.get(replica)) {
      this.entries.set(replica, seq);
    }
  }

  merge(other: VectorClock): void {
    for (const [replica, seq] of other.entries) {
      this.advanceTo(replica, seq);
    }
  }

  covers(origin: string, seq: number): boolean {
    return this.get(origin) >= seq;
  }

  replicas(): string[] {
    return [...this.entries.keys()];
  }

  equals(other: VectorClock): boolean {
    if (this.entries.size !== other.entries.size) return false;
    for (const [replica, seq] of this.entries) {
      if (other.get(replica) !== seq) return false;
    }
    return true;
  }

  clone(): VectorClock {
    const copy = new VectorClock();
    copy.merge(this);
    return copy;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries([...this.entries].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}
