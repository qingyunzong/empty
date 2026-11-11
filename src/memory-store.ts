import type { EventStore, LogEvent } from "./types.js";

/** 内存实现，主要用于测试；生产环境可替换为文件/数据库实现 */
export class InMemoryEventStore implements EventStore {
  private events: LogEvent[] = [];

  async readAll(): Promise<LogEvent[]> {
    return [...this.events];
  }

  async append(event: LogEvent): Promise<void> {
    this.events.push(event);
  }

  snapshot(): LogEvent[] {
    return [...this.events];
  }
}

export interface FaultRules {
  /** 匹配的事件类型写入失败（模拟成功后掉线等） */
  failTypes?: ReadonlySet<LogEvent["type"]>;
  /** 匹配 seq 的事件写入失败 */
  failSeqs?: ReadonlySet<number>;
  /** 第 N 次 append 失败（1 基） */
  failCall?: number;
  /** 每次 append 额外延迟，模拟网络抖动 */
  delayMs?: number;
}

/** 故障注入包装：按规则让 append 失败/延迟，用于覆盖各类故障路径 */
export class FaultyEventStore implements EventStore {
  private rules: FaultRules;
  private calls = 0;

  constructor(
    private readonly inner: EventStore,
    rules: FaultRules = {},
  ) {
    this.rules = rules;
  }

  clearFaults(): void {
    this.rules = {};
  }

  setRules(rules: FaultRules): void {
    this.rules = rules;
  }

  async readAll(): Promise<LogEvent[]> {
    return this.inner.readAll();
  }

  async append(event: LogEvent): Promise<void> {
    this.calls += 1;
    if (this.rules.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.rules.delayMs));
    }
    const rules = this.rules;
    if (rules.failTypes?.has(event.type)) {
      throw new Error(`故障注入：事件类型 ${event.type} 写入失败`);
    }
    if (rules.failSeqs?.has(event.seq)) {
      throw new Error(`故障注入：事件 seq=${event.seq} 写入失败`);
    }
    if (rules.failCall === this.calls) {
      throw new Error(`故障注入：第 ${this.calls} 次写入失败`);
    }
    await this.inner.append(event);
  }
}
