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
function deepEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (typeof a !== typeof b || a === null || b === null)
        return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        return (Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((v, i) => deepEqual(v, b[i])));
    }
    if (typeof a === 'object') {
        const ao = a;
        const bo = b;
        const ak = Object.keys(ao);
        const bk = Object.keys(bo);
        return ak.length === bk.length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
    }
    return false;
}
function vectorEqual(a, b) {
    const ak = Object.keys(a).filter((k) => a[k] !== 0);
    const bk = Object.keys(b).filter((k) => b[k] !== 0);
    return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}
export class CausalBroadcast {
    /** 每源已连续交付的最大序号 */
    deliveredSeq = new Map();
    /** 每源水位：seq <= 水位的消息保证不会再到达 */
    watermarks = new Map();
    /** 已见消息（含已交付与暂存），按 id */
    seenById = new Map();
    /** `source:seq` -> id，用于检测同源同序号异 ID 冲突 */
    seenBySeq = new Map();
    /** 暂存区：因果前驱未到的消息 */
    buffer = new Map();
    /** 交付日志（因果序） */
    deliveryLog = [];
    deliveredOf(source) {
        return this.deliveredSeq.get(source) ?? 0;
    }
    watermarkOf(source) {
        return this.watermarks.get(source) ?? 0;
    }
    /** 门控下限：已交付序号与水位共同覆盖到的序号 */
    floorOf(source) {
        return Math.max(this.deliveredOf(source), this.watermarkOf(source));
    }
    /** 计算一条消息当前不可交付的全部原因；为空数组表示可交付 */
    blockersOf(msg) {
        const reasons = [];
        const floor = this.floorOf(msg.source);
        if (msg.seq > floor + 1) {
            reasons.push({
                kind: 'missing-predecessor',
                source: msg.source,
                expectedSeq: floor + 1,
            });
        }
        for (const [depSource, requiredSeq] of Object.entries(msg.deps)) {
            if (depSource === msg.source && requiredSeq < msg.seq)
                continue; // 自身前驱由序号规则覆盖
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
    receive(msg) {
        if (!Number.isInteger(msg.seq) || msg.seq < 1) {
            return { status: 'rejected', reason: { kind: 'invalid-sequence', id: msg.id, seq: msg.seq } };
        }
        const prior = this.seenById.get(msg.id);
        if (prior !== undefined) {
            const identical = prior.source === msg.source &&
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
    declareWatermark(source, seq) {
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
    pending() {
        return [...this.buffer.values()].map((message) => ({
            id: message.id,
            message,
            reasons: this.blockersOf(message),
        }));
    }
    /** 单条暂存消息的待决原因；未暂存时返回 null */
    pendingReasons(id) {
        const msg = this.buffer.get(id);
        return msg === undefined ? null : this.blockersOf(msg);
    }
    /** 已交付消息日志（交付顺序即一种因果线性化） */
    delivered() {
        return this.deliveryLog;
    }
    isDelivered(id) {
        const msg = this.seenById.get(id);
        return msg !== undefined && !this.buffer.has(id);
    }
    deliveredSeqOf(source) {
        return this.deliveredOf(source);
    }
    watermarkOfSource(source) {
        return this.watermarkOf(source);
    }
    /** 扫描暂存区，交付所有因果就绪的消息，直到不动点 */
    cascade() {
        const newlyDelivered = [];
        for (;;) {
            let ready;
            for (const msg of this.buffer.values()) {
                if (this.blockersOf(msg).length === 0) {
                    ready = msg;
                    break;
                }
            }
            if (ready === undefined)
                break;
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
