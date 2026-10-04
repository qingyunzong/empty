import { createHash } from "node:crypto";
export class DiffVerificationError extends Error {
    constructor(message) {
        super(message);
        this.name = "DiffVerificationError";
    }
}
function canonical(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return "[" + value.map(canonical).join(",") + "]";
    const obj = value;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}
function sha256(text) {
    return createHash("sha256").update(text).digest("hex");
}
function deepFreeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
        }
    }
    return value;
}
function freezeRule(rule) {
    return Object.freeze({ id: rule.id, decision: rule.decision, source: rule.source });
}
export function summarizeRule(rule) {
    return { id: rule.id, decision: rule.decision, source: rule.source, hash: sha256(canonical(rule)) };
}
function summaryEquals(a, b) {
    if (a === null || b === null)
        return a === b;
    return a.hash === b.hash && a.decision === b.decision && a.source === b.source && a.id === b.id;
}
/** 规则集合的内容指纹：与插入顺序无关。 */
export function digestOf(rules) {
    const ordered = [...rules.keys()].sort().map((id) => rules.get(id));
    return sha256(canonical(ordered));
}
function opOf(before, after) {
    if (before === null)
        return "add";
    if (after === null)
        return "delete";
    return "update";
}
function sortEntries(entries) {
    return entries.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
}
/**
 * 先核后放：在基底副本上校验并应用差分。
 * 任一前置摘要不匹配、或结果指纹不符，都抛 DiffVerificationError，基底不被改动。
 */
export function applyDiffChecked(base, diff) {
    const baseDigest = digestOf(base);
    if (baseDigest !== diff.fromDigest) {
        throw new DiffVerificationError(`base digest mismatch: expected ${diff.fromDigest}, got ${baseDigest}`);
    }
    const next = new Map(base);
    for (const entry of diff.entries) {
        const current = next.get(entry.ruleId) ?? null;
        const currentSummary = current === null ? null : summarizeRule(current);
        if (!summaryEquals(currentSummary, entry.before)) {
            throw new DiffVerificationError(`before-summary mismatch for rule "${entry.ruleId}"`);
        }
        if (entry.after === null) {
            next.delete(entry.ruleId);
        }
        else {
            next.set(entry.ruleId, freezeRule({ id: entry.ruleId, decision: entry.after.decision, source: entry.after.source }));
        }
    }
    const nextDigest = digestOf(next);
    if (nextDigest !== diff.toDigest) {
        throw new DiffVerificationError(`result digest mismatch: expected ${diff.toDigest}, got ${nextDigest}`);
    }
    return next;
}
/** 逆差分：条目倒序、前后摘要互换，用于逆发布。 */
export function invertDiff(diff) {
    const entries = diff.entries
        .slice()
        .reverse()
        .map((entry) => ({
        ruleId: entry.ruleId,
        op: opOf(entry.after, entry.before),
        before: entry.after,
        after: entry.before,
    }));
    return { entries, fromDigest: diff.toDigest, toDigest: diff.fromDigest };
}
/** 差分复合：first 之后接 second，净效果合并为单个差分；净无变化的条目被消去。 */
export function composeDiffs(first, second) {
    if (first.toDigest !== second.fromDigest) {
        throw new DiffVerificationError("diffs are not adjacent: cannot compose");
    }
    const byId = new Map();
    for (const entry of first.entries)
        byId.set(entry.ruleId, { before: entry.before, after: entry.after });
    for (const entry of second.entries) {
        const prev = byId.get(entry.ruleId);
        if (prev === undefined) {
            byId.set(entry.ruleId, { before: entry.before, after: entry.after });
        }
        else {
            prev.after = entry.after;
        }
    }
    const entries = [];
    for (const [ruleId, slot] of byId) {
        if (summaryEquals(slot.before, slot.after))
            continue;
        entries.push({ ruleId, op: opOf(slot.before, slot.after), before: slot.before, after: slot.after });
    }
    return { entries: sortEntries(entries), fromDigest: first.fromDigest, toDigest: second.toDigest };
}
/** 读者快照：私有副本 + 冻结规则，热更不影响已持有的快照。 */
export class Snapshot {
    versionId;
    digest;
    rules;
    constructor(versionId, digest, rules) {
        this.versionId = versionId;
        this.digest = digest;
        this.rules = new Map(rules);
        Object.freeze(this);
    }
    get size() {
        return this.rules.size;
    }
    has(ruleId) {
        return this.rules.has(ruleId);
    }
    getRule(ruleId) {
        return this.rules.get(ruleId);
    }
    decide(ruleId) {
        return this.rules.get(ruleId)?.decision;
    }
    listRules() {
        return [...this.rules.keys()].sort().map((id) => this.rules.get(id));
    }
}
/**
 * 策略库：追加式版本日志。
 * - 批增删发布生成带前后摘要的差分；
 * - 逆发布先核后像，失败则历史不变；
 * - 历史版本只读，永不修改。
 */
export class StrategyLibrary {
    versions = [];
    states = new Map();
    constructor() {
        const empty = new Map();
        const digest = digestOf(empty);
        this.versions.push(deepFreeze({ id: 0, digest, parent: null, diff: { entries: [], fromDigest: digest, toDigest: digest } }));
        this.states.set(0, empty);
    }
    get head() {
        return this.versions[this.versions.length - 1];
    }
    get versionCount() {
        return this.versions.length;
    }
    getVersion(id) {
        const version = this.versions[id];
        if (version === undefined)
            throw new RangeError(`unknown version: ${id}`);
        return version;
    }
    /** 读者快照：默认取当前头版本；返回独立副本，与后续热更隔离。 */
    getSnapshot(versionId) {
        const id = versionId ?? this.head.id;
        const version = this.getVersion(id);
        const rules = this.states.get(id);
        if (rules === undefined)
            throw new RangeError(`unknown version: ${id}`);
        return new Snapshot(version.id, version.digest, rules);
    }
    /** 批量增删改发布：生成带前后摘要的差分，追加新版本，历史不变。 */
    publish(ops) {
        const base = this.states.get(this.head.id);
        const next = new Map(base);
        const acc = new Map();
        for (const op of ops) {
            if (op.type === "put") {
                const rule = freezeRule(op.rule);
                const existing = next.get(rule.id) ?? null;
                const slot = acc.get(rule.id) ?? { before: existing === null ? null : summarizeRule(existing), after: null };
                slot.after = summarizeRule(rule);
                acc.set(rule.id, slot);
                next.set(rule.id, rule);
            }
            else {
                const existing = next.get(op.ruleId);
                if (existing === undefined)
                    throw new Error(`cannot delete unknown rule: ${op.ruleId}`);
                const slot = acc.get(op.ruleId) ?? { before: summarizeRule(existing), after: null };
                slot.after = null;
                acc.set(op.ruleId, slot);
                next.delete(op.ruleId);
            }
        }
        const entries = [];
        for (const [ruleId, slot] of acc) {
            if (summaryEquals(slot.before, slot.after))
                continue;
            entries.push({ ruleId, op: opOf(slot.before, slot.after), before: slot.before, after: slot.after });
        }
        const diff = {
            entries: sortEntries(entries),
            fromDigest: digestOf(base),
            toDigest: digestOf(next),
        };
        // 发布自检：差分必须能把基底精确重放到新状态。
        applyDiffChecked(base, diff);
        return this.commit(diff, next);
    }
    /**
     * 逆发布：先核后像。
     * 核：把当前到头目标版本的差分链求逆，在临时副本上重放，
     *     校验结果指纹与目标历史版本一致（决议与来源完全恢复）；
     * 像：校验通过后才追加新版本；任何不一致都抛错且历史不变。
     */
    inversePublish(targetVersionId) {
        const target = this.getVersion(targetVersionId);
        if (target.id >= this.head.id) {
            throw new RangeError("inverse publish target must be an earlier version");
        }
        const chain = [];
        for (let v = target.id + 1; v <= this.head.id; v++)
            chain.push(this.versions[v].diff);
        let combined = chain[0];
        for (let i = 1; i < chain.length; i++)
            combined = composeDiffs(combined, chain[i]);
        const inverse = invertDiff(combined);
        // 先核：仅在临时副本上重放并比对目标指纹。
        const current = this.states.get(this.head.id);
        const restored = applyDiffChecked(current, inverse);
        if (digestOf(restored) !== target.digest) {
            throw new DiffVerificationError(`inverse publish verification failed against version ${target.id}`);
        }
        // 后像：核验通过，追加恢复出的新映像。
        return this.commit(inverse, restored);
    }
    commit(diff, rules) {
        const version = deepFreeze({
            id: this.versions.length,
            digest: diff.toDigest,
            parent: this.head.id,
            diff,
        });
        this.versions.push(version);
        this.states.set(version.id, new Map(rules));
        return version;
    }
}
