/**
 * 对照实现：引用计数式依赖管理。
 *
 * 与主库（reactive.ts）的差异：
 * - 读取发生时立即 acquire（引用计数 +1 并订阅），而不是事务结束时一次登记；
 * - 每次重算开始时先 release 全部旧依赖，再随读取逐个重新 acquire；
 * - 没有“事务提交”概念，因此：
 *   a) 计算抛错时旧依赖已被退订且不会恢复 —— 依赖丢失；
 *   b) 重算中途销毁后，后续读取仍会立即订阅 —— 留下泄漏订阅；
 *   c) 依赖集合不变的重算也产生成对的退订/订阅 —— 订阅 churn。
 */

let clock = 0;

let currentObserver: RefDerived | null = null;

let batchDepth = 0;
const pendingEffects: RefEffectNode[] = [];

export const metrics = {
  subscribes: 0,
  unsubscribes: 0,
  reset(): void {
    this.subscribes = 0;
    this.unsubscribes = 0;
  },
};

abstract class RefNode {
  private counts = new Map<RefDerived, number>();
  private subs = new Set<RefDerived>();

  abstract version(): number;

  acquire(obs: RefDerived): void {
    const n = (this.counts.get(obs) ?? 0) + 1;
    this.counts.set(obs, n);
    if (n === 1) {
      this.subs.add(obs);
      metrics.subscribes++;
    }
  }

  release(obs: RefDerived): void {
    const n = this.counts.get(obs) ?? 0;
    if (n <= 1) {
      this.counts.delete(obs);
      if (this.subs.delete(obs)) metrics.unsubscribes++;
    } else {
      this.counts.set(obs, n - 1);
    }
  }

  notify(): void {
    for (const s of [...this.subs]) s.markDirty();
  }

  subscriberCount(): number {
    return this.subs.size;
  }
}

abstract class RefDerived extends RefNode {
  /** 本观察者持有的引用计数（按依赖）。 */
  protected deps = new Map<RefNode, number>();
  disposed = false;

  abstract markDirty(): void;

  /** 读取发生处立即登记。 */
  track(dep: RefNode): void {
    this.deps.set(dep, (this.deps.get(dep) ?? 0) + 1);
    dep.acquire(this);
  }

  /** 重算开始/销毁时退订全部旧依赖。 */
  protected releaseAll(): void {
    for (const [dep, n] of this.deps) {
      for (let i = 0; i < n; i++) dep.release(this);
    }
    this.deps.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAll();
  }

  dependencyCount(): number {
    return this.deps.size;
  }
}

class RefSourceNode<T> extends RefNode {
  private value: T;
  private ver = 0;

  constructor(initial: T) {
    super();
    this.value = initial;
  }

  version(): number {
    return this.ver;
  }

  get(): T {
    currentObserver?.track(this);
    return this.value;
  }

  set(v: T): void {
    if (Object.is(v, this.value)) return;
    batchDepth++;
    try {
      this.value = v;
      this.ver = ++clock;
      this.notify();
    } finally {
      batchDepth--;
      if (batchDepth === 0) flushEffects();
    }
  }
}

class RefComputedNode<T> extends RefDerived {
  private fn: () => T;
  private value!: T;
  private ver = 0;
  private dirty = true;
  private seen = new Map<RefNode, number>();
  private err: unknown;
  private hasErr = false;

  constructor(fn: () => T) {
    super();
    this.fn = fn;
  }

  version(): number {
    return this.ver;
  }

  markDirty(): void {
    if (this.disposed || this.dirty) return;
    this.dirty = true;
    this.notify();
  }

  get(): T {
    if (this.disposed) {
      const prev = currentObserver;
      currentObserver = null;
      try {
        return this.fn();
      } finally {
        currentObserver = prev;
      }
    }
    currentObserver?.track(this);
    this.updateIfNecessary();
    if (this.hasErr) throw this.err;
    return this.value;
  }

  private updateIfNecessary(): void {
    if (!this.dirty) {
      for (const [dep, seenVer] of this.seen) {
        if (dep instanceof RefComputedNode) dep.updateIfNecessary();
        if (dep.version() !== seenVer) {
          this.dirty = true;
          break;
        }
      }
    }
    if (!this.dirty) return;
    // 重算开始即退订全部旧依赖 —— 与主库的关键差异。
    this.releaseAll();
    const prev = currentObserver;
    currentObserver = this;
    let next!: T;
    let threw = false;
    let error: unknown;
    try {
      next = this.fn();
    } catch (e) {
      threw = true;
      error = e;
    } finally {
      currentObserver = prev;
    }
    // 注意：即使中途被 dispose，读取时已 acquire 的订阅也不会被收回 —— 泄漏。
    if (threw) {
      // 旧依赖已在 releaseAll 中丢失，无法恢复。
      this.err = error;
      this.hasErr = true;
    } else {
      this.value = next;
      this.hasErr = false;
      this.err = undefined;
      this.ver = ++clock;
    }
    this.seen = new Map([...this.deps.keys()].map((d) => [d, d.version()]));
    this.dirty = false;
  }
}

class RefEffectNode extends RefDerived {
  private fn: () => void;
  private queued = false;
  err: unknown;
  hasErr = false;

  constructor(fn: () => void) {
    super();
    this.fn = fn;
    this.run();
  }

  version(): number {
    return 0; // 效果不作为依赖被读取
  }

  markDirty(): void {
    if (this.disposed || this.queued) return;
    this.queued = true;
    pendingEffects.push(this);
  }

  run(): void {
    this.queued = false;
    if (this.disposed) return;
    this.releaseAll();
    const prev = currentObserver;
    currentObserver = this;
    try {
      this.fn();
      this.hasErr = false;
      this.err = undefined;
    } catch (e) {
      this.hasErr = true;
      this.err = e;
    } finally {
      currentObserver = prev;
    }
  }
}

function flushEffects(): void {
  while (pendingEffects.length > 0) {
    pendingEffects.shift()!.run();
  }
}

export interface RSource<T> {
  get(): T;
  set(v: T): void;
  subscriberCount(): number;
}

export interface RComputed<T> {
  get(): T;
  dispose(): void;
  readonly disposed: boolean;
  subscriberCount(): number;
  dependencyCount(): number;
}

export interface REffect {
  dispose(): void;
  readonly disposed: boolean;
  readonly error: unknown;
}

export function source<T>(initial: T): RSource<T> {
  const n = new RefSourceNode(initial);
  return {
    get: () => n.get(),
    set: (v) => n.set(v),
    subscriberCount: () => n.subscriberCount(),
  };
}

export function computed<T>(fn: () => T): RComputed<T> {
  const n = new RefComputedNode(fn);
  return {
    get: () => n.get(),
    dispose: () => n.dispose(),
    get disposed() {
      return n.disposed;
    },
    subscriberCount: () => n.subscriberCount(),
    dependencyCount: () => n.dependencyCount(),
  };
}

export function effect(fn: () => void): REffect {
  const n = new RefEffectNode(fn);
  return {
    dispose: () => n.dispose(),
    get disposed() {
      return n.disposed;
    },
    get error() {
      return n.hasErr ? n.err : undefined;
    },
  };
}
