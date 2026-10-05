/**
 * 对照实现：全量重算 与 引用计数。
 * 仅用于测试中与事务式核心（reactive.ts）对比行为差异。
 */

/* ---------------- 全量重算：任何写入都重跑所有 effect ---------------- */

export class FullRecomputeRoot {
  private effects: FullRecomputeEffect[] = [];

  signal<T>(value: T): FullRecomputeSignal<T> {
    return new FullRecomputeSignal<T>(this, value);
  }

  effect(fn: () => void): FullRecomputeEffect {
    const e = new FullRecomputeEffect(fn);
    this.effects.push(e);
    e.run();
    return e;
  }

  /** 任何 signal 写入后重跑全部 effect（不做依赖追踪） */
  _notifyAll(): void {
    for (const e of this.effects) e.run();
  }

  get effectCount(): number {
    return this.effects.length;
  }
}

export class FullRecomputeSignal<T> {
  constructor(private root: FullRecomputeRoot, private value: T) {}

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    this.root._notifyAll();
  }
}

export class FullRecomputeEffect {
  runs = 0;

  constructor(private readonly fn: () => void) {}

  run(): void {
    this.fn();
    this.runs++;
  }
}

/* ------------- 引用计数：边读边订阅，retain/release 成对出现 ------------- */

interface RefNode {
  readonly refCount: number;
  _retain(child: RefComputed<unknown>): void;
  _release(child: RefComputed<unknown>): void;
}

let refActive: RefComputed<unknown> | null = null;

export class RefSignal<T> implements RefNode {
  private children = new Set<RefComputed<unknown>>();
  refCount = 0;

  constructor(private value: T) {}

  get(): T {
    refActive?._read(this);
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    for (const c of [...this.children]) c._invalidate();
  }

  _retain(child: RefComputed<unknown>): void {
    this.children.add(child);
    this.refCount++;
  }

  _release(child: RefComputed<unknown>): void {
    this.children.delete(child);
    this.refCount--;
  }

  get subscriberCount(): number {
    return this.children.size;
  }
}

export class RefComputed<T> implements RefNode {
  private children = new Set<RefComputed<unknown>>();
  private deps: RefNode[] = [];
  private cached!: T;
  private dirty = true;
  refCount = 0;
  evaluations = 0;

  constructor(private readonly fn: () => T) {}

  /** 读取时立即订阅（引用计数 +1），与事务式“结束时一次登记”相反 */
  _read(source: RefNode): void {
    source._retain(this as RefComputed<unknown>);
    this.deps.push(source);
  }

  get(): T {
    refActive?._read(this);
    if (this.dirty) this.recompute();
    return this.cached;
  }

  private recompute(): void {
    // 先释放全部旧依赖，再边读边重新订阅
    for (const dep of this.deps) dep._release(this as RefComputed<unknown>);
    this.deps = [];
    const prev = refActive;
    refActive = this as RefComputed<unknown>;
    try {
      this.cached = this.fn(); // 若此处抛错：已读依赖已 retain，未读依赖已丢失
      this.evaluations++;
      this.dirty = false;
    } finally {
      refActive = prev;
    }
  }

  _invalidate(): void {
    if (this.dirty) return;
    this.dirty = true;
    for (const c of [...this.children]) c._invalidate();
  }

  _retain(child: RefComputed<unknown>): void {
    this.children.add(child);
    this.refCount++;
  }

  _release(child: RefComputed<unknown>): void {
    this.children.delete(child);
    this.refCount--;
    // 引用计数归零：级联释放上游
    if (this.refCount === 0) {
      for (const dep of this.deps) dep._release(this as RefComputed<unknown>);
      this.deps = [];
    }
  }

  get subscriberCount(): number {
    return this.children.size;
  }

  get depCount(): number {
    return this.deps.length;
  }
}
