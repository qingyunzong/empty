"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolicyStore = exports.Snapshot = exports.DiffVerificationError = void 0;
const diff_1 = require("./diff");
const rules_1 = require("./rules");
class DiffVerificationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DiffVerificationError';
    }
}
exports.DiffVerificationError = DiffVerificationError;
function immutableView(rules) {
    const view = {
        get size() {
            return rules.size;
        },
        get: (id) => rules.get(id),
        has: (id) => rules.has(id),
        keys: () => rules.keys(),
        values: () => rules.values(),
        entries: () => rules.entries(),
        forEach: (callback, thisArg) => rules.forEach(callback, thisArg),
        [Symbol.iterator]: () => rules[Symbol.iterator](),
    };
    return Object.freeze(view);
}
class Snapshot {
    pinned;
    constructor(pinned) {
        this.pinned = pinned;
    }
    get seq() {
        return this.pinned.seq;
    }
    get summary() {
        return this.pinned.summary;
    }
    get(id) {
        return this.pinned.rules.get(id);
    }
    has(id) {
        return this.pinned.rules.has(id);
    }
    list() {
        return [...this.pinned.rules.values()].sort(rules_1.byId);
    }
}
exports.Snapshot = Snapshot;
class PolicyStore {
    history = [];
    constructor() {
        const rules = new Map();
        this.history.push({
            seq: 0,
            rules: immutableView(rules),
            summary: (0, rules_1.summarize)(rules),
        });
    }
    get current() {
        const tip = this.history[this.history.length - 1];
        if (tip === undefined)
            throw new Error('store has no version');
        return tip;
    }
    get length() {
        return this.history.length;
    }
    version(seq) {
        const found = this.history[seq];
        if (found === undefined)
            throw new RangeError(`no version with seq ${seq}`);
        return found;
    }
    plan(batch) {
        const base = this.current;
        const next = new Map(base.rules);
        const pendingAdds = new Map();
        const removed = [];
        for (const op of batch) {
            if (op.kind === 'add') {
                if (next.has(op.rule.id)) {
                    throw new Error(`duplicate rule id: ${op.rule.id}`);
                }
                const rule = Object.freeze({ ...op.rule });
                next.set(rule.id, rule);
                pendingAdds.set(rule.id, rule);
            }
            else {
                const pending = pendingAdds.get(op.id);
                if (pending !== undefined) {
                    pendingAdds.delete(op.id);
                    next.delete(op.id);
                    continue;
                }
                const existing = next.get(op.id);
                if (existing === undefined) {
                    throw new Error(`unknown rule id: ${op.id}`);
                }
                next.delete(op.id);
                removed.push(existing);
            }
        }
        const added = [...pendingAdds.values()];
        added.sort(rules_1.byId);
        removed.sort(rules_1.byId);
        return { before: base.summary, after: (0, rules_1.summarize)(next), added, removed };
    }
    publish(diff) {
        const base = this.current;
        if (!(0, rules_1.sameSummary)(diff.before, base.summary)) {
            throw new DiffVerificationError(`diff before-summary does not match current version ${base.seq}`);
        }
        const next = new Map(base.rules);
        for (const rule of diff.removed) {
            if (!next.delete(rule.id)) {
                throw new DiffVerificationError(`cannot remove absent rule id: ${rule.id}`);
            }
        }
        for (const rule of diff.added) {
            if (next.has(rule.id)) {
                throw new DiffVerificationError(`cannot add existing rule id: ${rule.id}`);
            }
            next.set(rule.id, Object.freeze({ ...rule }));
        }
        const summary = (0, rules_1.summarize)(next);
        if (!(0, rules_1.sameSummary)(summary, diff.after)) {
            throw new DiffVerificationError('materialized image does not match diff after-summary');
        }
        const version = Object.freeze({
            seq: base.seq + 1,
            rules: immutableView(next),
            summary,
        });
        this.history.push(version);
        return version;
    }
    unpublish(diff) {
        return this.publish((0, diff_1.invertDiff)(diff));
    }
    snapshot() {
        return new Snapshot(this.current);
    }
}
exports.PolicyStore = PolicyStore;
