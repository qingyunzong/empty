export type TraceSource = "broker" | "consumer" | "store";

export interface TraceEvent {
  seq: number;
  at: number;
  source: TraceSource;
  type: string;
  detail: Record<string, unknown>;
}

/**
 * 全量轨迹日志：每一次投递（含重复投递）、每一次 ACK（含被拒绝的旧世代 ACK）、
 * 每一次事务提交/回滚都会保留，用于核对“业务效果一次、轨迹保留重复”。
 */
export class TraceLog {
  private readonly events: TraceEvent[] = [];
  private seq = 0;

  constructor(private readonly now: () => number) {}

  record(source: TraceSource, type: string, detail: Record<string, unknown> = {}): void {
    this.events.push({ seq: ++this.seq, at: this.now(), source, type, detail });
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }

  ofType(type: string): TraceEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  count(type: string): number {
    return this.ofType(type).length;
  }

  /** 针对某条消息 id 的轨迹，便于断言重复投递被保留。 */
  forMessage(id: string): TraceEvent[] {
    return this.events.filter((e) => e.detail["id"] === id);
  }

  format(): string {
    return this.events
      .map((e) => `#${e.seq} t=${e.at} [${e.source}] ${e.type} ${JSON.stringify(e.detail)}`)
      .join("\n");
  }
}
