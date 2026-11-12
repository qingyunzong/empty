import type { PageAdapter, VersionedSnapshot } from "../src/types.ts";

/**
 * 内存版文档适配器：
 * - read 始终返回最新版本及其（冻结的）不可变快照；
 * - subscribe 先按版本顺序重放 afterVersion 之后的全部历史变化，再接收实时变化；
 * - 记录投递顺序与解除订阅次数，供测试断言。
 */
export class FakePageAdapter<S> implements PageAdapter<S> {
  private history: VersionedSnapshot<S>[] = [];
  private readonly subscribers = new Set<
    (event: VersionedSnapshot<S>) => void
  >();

  readonly deliveredVersions: number[] = [];
  unsubscribeCalls = 0;

  constructor(initialSnapshot: S) {
    this.history.push({ version: 1, snapshot: Object.freeze(initialSnapshot) });
  }

  get latestVersion(): number {
    return this.history[this.history.length - 1]!.version;
  }

  read(): VersionedSnapshot<S> {
    return this.history[this.history.length - 1]!;
  }

  subscribe(
    afterVersion: number,
    onChange: (event: VersionedSnapshot<S>) => void,
  ): () => void {
    for (const event of this.history) {
      if (event.version > afterVersion) {
        this.deliver(onChange, event);
      }
    }
    this.subscribers.add(onChange);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.unsubscribeCalls += 1;
      this.subscribers.delete(onChange);
    };
  }

  /** 产生一个严格递增的新版本，并同步投递给所有现存订阅者。 */
  mutate(snapshot: S): VersionedSnapshot<S> {
    const event: VersionedSnapshot<S> = {
      version: this.latestVersion + 1,
      snapshot: Object.freeze(snapshot),
    };
    this.history.push(event);
    for (const subscriber of [...this.subscribers]) {
      this.deliver(subscriber, event);
    }
    return event;
  }

  private deliver(
    subscriber: (event: VersionedSnapshot<S>) => void,
    event: VersionedSnapshot<S>,
  ): void {
    this.deliveredVersions.push(event.version);
    subscriber(event);
  }
}

/** 等待微任务队列排空，便于观察 Promise 终态。 */
export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * 模拟真实异步适配器的读-订阅竞争：
 * read 之后、subscribe 调用之前“线上”已经产生新版本，
 * subscribe 必须从 afterVersion 之后按版本顺序重放这些变化。
 */
export class ReplayRaceAdapter<S> implements PageAdapter<S> {
  private events: VersionedSnapshot<S>[];
  private readonly subscribers = new Set<
    (event: VersionedSnapshot<S>) => void
  >();

  readonly replayLog: number[] = [];
  unsubscribeCalls = 0;
  subscribeArg: number | null = null;

  constructor(initial: VersionedSnapshot<S>, ...missed: VersionedSnapshot<S>[]) {
    this.events = [initial, ...missed];
  }

  read(): VersionedSnapshot<S> {
    return this.events[0]!;
  }

  subscribe(
    afterVersion: number,
    onChange: (event: VersionedSnapshot<S>) => void,
  ): () => void {
    this.subscribeArg = afterVersion;
    for (const event of this.events) {
      if (event.version > afterVersion) {
        this.replayLog.push(event.version);
        onChange(event);
      }
    }
    this.subscribers.add(onChange);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.unsubscribeCalls += 1;
      this.subscribers.delete(onChange);
    };
  }

  pushLive(event: VersionedSnapshot<S>): void {
    this.events.push(event);
    for (const subscriber of [...this.subscribers]) {
      subscriber(event);
    }
  }
}
