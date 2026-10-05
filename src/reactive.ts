/**
 * 事务式响应式核心。
 *
 * 关键语义：
 * 1. 依赖在“读取事务”结束时一次性登记（原子提交），计算过程中不做任何订阅。
 * 2. 计算抛错时丢弃本次收集到的依赖，旧依赖集合保持不变。
 * 3. dispose 与重算交错时不会在源上留下订阅。
 */

export interface Source {
  /** 仅供派生节点在提交阶段调用 */
  _subscribe(d: Derived): void;
  _unsubscribe(d: Derived): void;
  /** 当前订阅者数量（测试与对照用） */
  readonly subscriberCount: number;
}

let activeCollector: Derived | null = null;

function trackRead(source: Source): void {
  if (activeCollector !== null) {
    activeCollector._track(source);
  }
}

export abstract class Derived {
  /** 已提交（生效中）的依赖 */
  private committedDeps: Source[] = [];
  private committedSet = new Set<Source>();
  /** 本次读取事务中收集到、尚未提交的依赖 */
  private pendingDeps = new Set<Source>();
  private disposed = false;
  private computing = false;

  _track(source: Source): void {
    this.pendingDeps.add(source);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 当前生效的依赖（快照，测试与对照用） */
  get deps(): readonly Source[] {
    return this.committedDeps;
  }

  /**
   * 在读取事务中执行 fn：
   * - 期间的所有读取只进入 pendingDeps，不触碰任何源的订阅列表；
   * - fn 成功返回后一次性提交（先退订多余的，再订阅新增的）；
   * - fn 抛错时丢弃 pendingDeps，旧依赖原样保留。
   */
  protected runTransaction<T>(fn: () => T): T {
    const prevCollector = activeCollector;
    activeCollector = this;
    this.pendingDeps.clear();
    this.computing = true;
    try {
      const result = fn();
      this.commitDeps();
      return result;
    } catch (err) {
      this.pendingDeps.clear(); // 抛错：旧依赖不变
      throw err;
    } finally {
      this.computing = false;
      activeCollector = prevCollector;
    }
  }

  /** 事务提交：一次性把 pendingDeps 变为生效依赖 */
  private commitDeps(): void {
    const next = this.pendingDeps;
    // 销毁发生在重算交错之间：不得留下任何订阅
    if (this.disposed) {
      next.clear();
      return;
    }
    for (const dep of this.committedDeps) {
      if (!next.has(dep)) {
        dep._unsubscribe(this);
        this.committedSet.delete(dep);
      }
    }
    for (const dep of next) {
      if (!this.committedSet.has(dep)) {
        dep._subscribe(this);
        this.committedSet.add(dep);
      }
    }
    this.committedDeps = [...next];
    next.clear();
  }

  /** 销毁：退订全部依赖；此后任何提交/失效传播都被忽略 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dep of this.committedDeps) {
      dep._unsubscribe(this);
    }
    this.committedDeps = [];
    this.committedSet.clear();
    this.pendingDeps.clear();
  }

  abstract _invalidate(): void;
}

export class Signal<T> implements Source {
  private subscribers = new Set<Derived>();

  constructor(private value: T) {}

  get(): T {
    trackRead(this);
    return this.value;
  }

  /** 不触发依赖收集的读取 */
  peek(): T {
    return this.value;
  }

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    // 快照迭代：通知过程中订阅列表可能被 dispose/commit 修改
    for (const sub of [...this.subscribers]) {
      sub._invalidate();
    }
  }

  _subscribe(d: Derived): void {
    this.subscribers.add(d);
  }

  _unsubscribe(d: Derived): void {
    this.subscribers.delete(d);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

export class Computed<T> extends Derived implements Source {
  private subscribers = new Set<Derived>();
  private cached!: T;
  private dirty = true;
  private evaluations = 0;

  constructor(private readonly fn: () => T) {
    super();
  }

  get(): T {
    if (this.isDisposed) {
      throw new Error("computed 已销毁，不能读取");
    }
    trackRead(this);
    if (this.dirty) {
      // 抛错时：dirty 保持为 true，cached 与旧依赖都不变
      this.cached = this.runTransaction(this.fn);
      this.evaluations++;
      this.dirty = false;
    }
    return this.cached;
  }

  /** 已成功的求值次数（测试与对照用） */
  get evaluationCount(): number {
    return this.evaluations;
  }

  _invalidate(): void {
    if (this.isDisposed) return; // 销毁后不再响应
    if (this.dirty) return; // 已脏，无需重复传播
    this.dirty = true;
    for (const sub of [...this.subscribers]) {
      sub._invalidate();
    }
  }

  _subscribe(d: Derived): void {
    this.subscribers.add(d);
  }

  _unsubscribe(d: Derived): void {
    this.subscribers.delete(d);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

export class Effect extends Derived {
  private runs = 0;

  constructor(private readonly fn: () => void) {
    super();
    this.run();
  }

  private run(): void {
    this.runTransaction(this.fn);
    this.runs++;
  }

  /** 成功运行的次数（测试与对照用） */
  get runCount(): number {
    return this.runs;
  }

  _invalidate(): void {
    if (this.isDisposed) return; // 销毁与重算交错：不再重跑
    this.run();
  }
}

export function signal<T>(value: T): Signal<T> {
  return new Signal(value);
}

export function computed<T>(fn: () => T): Computed<T> {
  return new Computed(fn);
}

export function effect(fn: () => void): Effect {
  return new Effect(fn);
}
