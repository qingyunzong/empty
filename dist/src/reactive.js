/**
 * 响应式状态库（主实现）。
 *
 * 核心语义：
 * 1. 读取事务：重算期间只“收集”读到的依赖，事务成功结束时一次性提交
 *    （退订不再读取的、订阅新读取的）。事务中途不产生任何订阅副作用。
 * 2. 计算抛错：丢弃本次收集的依赖集合，旧依赖与旧缓存值原样保留，
 *    错误被缓存并在 get() 时重抛，直到某个依赖变化触发成功重算。
 * 3. 销毁与重算交错：重算期间（含计算函数内部）若节点被销毁，提交阶段
 *    直接放弃，不会留下任何订阅；销毁后再读取只做一次性求值。
 * 4. 动态条件切换：条件分支切换后，不再读取的依赖在提交时被退订。
 */
let clock = 0;
let currentCollector = null;
let batchDepth = 0;
const pendingEffects = [];
/** 订阅/退订操作计数，供测试与对照实验观测。 */
export const metrics = {
    subscribes: 0,
    unsubscribes: 0,
    reset() {
        this.subscribes = 0;
        this.unsubscribes = 0;
    },
};
class ReactiveNode {
    subs = new Set();
    addSub(d) {
        if (!this.subs.has(d)) {
            this.subs.add(d);
            metrics.subscribes++;
        }
    }
    removeSub(d) {
        if (this.subs.delete(d))
            metrics.unsubscribes++;
    }
    notifySubs() {
        for (const s of [...this.subs])
            s.markDirty();
    }
    subscriberCount() {
        return this.subs.size;
    }
}
class Derived extends ReactiveNode {
    /** 已提交的依赖及其在提交时观测到的版本。 */
    deps = new Map();
    disposed = false;
    /**
     * 读取事务：运行 compute，期间仅收集依赖；成功结束且未被销毁时
     * 才一次性提交依赖变更。抛错时丢弃收集结果，旧依赖保持不变。
     */
    collect(compute) {
        const prev = currentCollector;
        const collected = new Set();
        currentCollector = {
            add: (dep) => {
                collected.add(dep);
            },
        };
        try {
            compute();
        }
        catch (error) {
            return { ok: false, error };
        }
        finally {
            currentCollector = prev;
        }
        // 销毁与重算交错：计算期间被销毁则放弃提交，不留订阅。
        if (!this.disposed)
            this.commit(collected);
        return { ok: true };
    }
    /** 事务结束时一次登记：退订不再读取的，订阅新读取的。 */
    commit(collected) {
        for (const dep of this.deps.keys()) {
            if (!collected.has(dep))
                dep.removeSub(this);
        }
        const next = new Map();
        for (const dep of collected) {
            if (!this.deps.has(dep))
                dep.addSub(this);
            // 版本在提交时（计算函数已运行完毕）取值，保证读到的是稳定版本。
            next.set(dep, dep.version());
        }
        this.deps = next;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const dep of this.deps.keys())
            dep.removeSub(this);
        this.deps.clear();
    }
    dependencyCount() {
        return this.deps.size;
    }
}
class SourceNode extends ReactiveNode {
    value;
    ver = 0;
    constructor(initial) {
        super();
        this.value = initial;
    }
    version() {
        return this.ver;
    }
    get() {
        currentCollector?.add(this);
        return this.value;
    }
    set(v) {
        if (Object.is(v, this.value))
            return;
        batchDepth++;
        try {
            this.value = v;
            this.ver = ++clock;
            this.notifySubs();
        }
        finally {
            batchDepth--;
            if (batchDepth === 0)
                flushEffects();
        }
    }
}
class ComputedNode extends Derived {
    fn;
    value;
    ver = 0;
    dirty = true;
    err;
    hasErr = false;
    constructor(fn) {
        super();
        this.fn = fn;
    }
    version() {
        return this.ver;
    }
    markDirty() {
        if (this.disposed || this.dirty)
            return;
        this.dirty = true;
        this.notifySubs();
    }
    get() {
        if (this.disposed)
            return this.computeUntracked();
        currentCollector?.add(this);
        this.updateIfNecessary();
        if (this.hasErr)
            throw this.err;
        return this.value;
    }
    /** 已销毁节点：一次性求值，不登记任何订阅。 */
    computeUntracked() {
        const prev = currentCollector;
        currentCollector = null;
        try {
            return this.fn();
        }
        finally {
            currentCollector = prev;
        }
    }
    updateIfNecessary() {
        if (!this.dirty) {
            for (const [dep, seen] of this.deps) {
                if (dep instanceof ComputedNode)
                    dep.updateIfNecessary();
                if (dep.version() !== seen) {
                    this.dirty = true;
                    break;
                }
            }
        }
        if (!this.dirty)
            return;
        let next;
        const result = this.collect(() => {
            next = this.fn();
        });
        if (result.ok) {
            // 即使计算期间被销毁，也缓存本次结果供当前这次 get 返回；
            // 但已销毁节点不推进版本、不登记依赖。
            this.value = next;
            this.hasErr = false;
            this.err = undefined;
            if (!this.disposed) {
                this.ver = ++clock;
                this.dirty = false;
            }
        }
        else {
            // 计算抛错：旧依赖与旧值不变，仅缓存错误。
            this.err = result.error;
            this.hasErr = true;
            this.dirty = false;
        }
    }
}
class EffectNode extends Derived {
    fn;
    queued = false;
    err;
    hasErr = false;
    constructor(fn) {
        super();
        this.fn = fn;
        this.run();
    }
    version() {
        return 0; // 效果不作为依赖被读取
    }
    markDirty() {
        if (this.disposed || this.queued)
            return;
        this.queued = true;
        pendingEffects.push(this);
    }
    run() {
        this.queued = false;
        if (this.disposed)
            return; // flush 前被销毁：不再运行
        const result = this.collect(() => {
            this.fn();
        });
        if (result.ok) {
            this.hasErr = false;
            this.err = undefined;
        }
        else {
            // 与 computed 一致：抛错保留旧依赖
            this.hasErr = true;
            this.err = result.error;
        }
    }
}
function flushEffects() {
    while (pendingEffects.length > 0) {
        const e = pendingEffects.shift();
        e.run();
    }
}
export function source(initial) {
    const n = new SourceNode(initial);
    return {
        get: () => n.get(),
        set: (v) => n.set(v),
        update: (fn) => n.set(fn(n.get())),
        subscriberCount: () => n.subscriberCount(),
    };
}
export function computed(fn) {
    const n = new ComputedNode(fn);
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
export function effect(fn) {
    const n = new EffectNode(fn);
    return {
        dispose: () => n.dispose(),
        get disposed() {
            return n.disposed;
        },
        get error() {
            return n.hasErr ? n.err : undefined;
        },
        dependencyCount: () => n.dependencyCount(),
    };
}
/** 批量更新：多次 set 只触发一轮 effect。 */
export function batch(fn) {
    batchDepth++;
    try {
        fn();
    }
    finally {
        batchDepth--;
        if (batchDepth === 0)
            flushEffects();
    }
}
