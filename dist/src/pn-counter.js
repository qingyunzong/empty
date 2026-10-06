"use strict";
/**
 * PN-Counter CRDT。
 *
 * - 每个副本的每一代际维护一对只增分量：inc（增量）与 dec（减量）。
 * - 合并时对每个 (replicaId, generation) 的 inc/dec 分别取最大值，
 *   满足交换律、结合律、幂等，乱序/重复合并收敛。
 * - 撤回通过新增反向量实现（撤 increment 就追加等量 dec），
 *   旧分量只增不减，绝不删除。
 * - 副本重启进入新代际：旧代际分量原样保留，新代际从零累计。
 * - 所有计数均为 bigint，可表示任意精度整数（含负结果）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PNCounter = void 0;
class PNCounter {
    replicaId;
    generation;
    components = new Map();
    constructor(replicaId, generation = 1) {
        this.replicaId = replicaId;
        this.generation = generation;
        this.currentComponent();
    }
    static componentKey(replicaId, generation) {
        return `${replicaId}#${generation}`;
    }
    get currentGeneration() {
        return this.generation;
    }
    currentComponent() {
        const key = PNCounter.componentKey(this.replicaId, this.generation);
        let component = this.components.get(key);
        if (component === undefined) {
            component = { inc: 0n, dec: 0n };
            this.components.set(key, component);
        }
        return component;
    }
    static assertPositive(amount) {
        if (amount <= 0n) {
            throw new RangeError(`amount must be a positive bigint, got ${amount}`);
        }
    }
    increment(amount = 1n) {
        PNCounter.assertPositive(amount);
        this.currentComponent().inc += amount;
    }
    decrement(amount = 1n) {
        PNCounter.assertPositive(amount);
        this.currentComponent().dec += amount;
    }
    /** 撤回一笔增量：新增等量反向量（dec），不删改旧的 inc。 */
    undoIncrement(amount = 1n) {
        this.decrement(amount);
    }
    /** 撤回一笔减量：新增等量反向量（inc），不删改旧的 dec。 */
    undoDecrement(amount = 1n) {
        this.increment(amount);
    }
    /** 副本重启：代际 +1，旧代际分量保留，新代际分量从零开始。 */
    restart() {
        this.generation += 1;
        this.currentComponent();
    }
    /** 当前计数值：所有 (副本, 代际) 分量的 inc - dec 之和。 */
    value() {
        let sum = 0n;
        for (const component of this.components.values()) {
            sum += component.inc - component.dec;
        }
        return sum;
    }
    /** 合并：对每个 (副本, 代际) 的 inc/dec 分别取最大。幂等。 */
    merge(other) {
        for (const [key, remote] of other.components) {
            const local = this.components.get(key);
            if (local === undefined) {
                this.components.set(key, { inc: remote.inc, dec: remote.dec });
            }
            else {
                if (remote.inc > local.inc)
                    local.inc = remote.inc;
                if (remote.dec > local.dec)
                    local.dec = remote.dec;
            }
        }
    }
    /** 只读查看某副本某代际的分量（不存在则返回 undefined）。 */
    componentOf(replicaId, generation) {
        const component = this.components.get(PNCounter.componentKey(replicaId, generation));
        return component === undefined ? undefined : { ...component };
    }
    /** 已知的所有 (副本#代际) 分量键。 */
    componentKeys() {
        return [...this.components.keys()];
    }
    clone() {
        const copy = new PNCounter(this.replicaId, this.generation);
        copy.components.clear();
        for (const [key, component] of this.components) {
            copy.components.set(key, { ...component });
        }
        return copy;
    }
    snapshot() {
        const snapshot = {};
        for (const [key, component] of this.components) {
            snapshot[key] = { inc: component.inc.toString(), dec: component.dec.toString() };
        }
        return snapshot;
    }
    static fromSnapshot(replicaId, generation, snapshot) {
        const counter = new PNCounter(replicaId, generation);
        counter.components.clear();
        for (const [key, component] of Object.entries(snapshot)) {
            counter.components.set(key, { inc: BigInt(component.inc), dec: BigInt(component.dec) });
        }
        return counter;
    }
}
exports.PNCounter = PNCounter;
