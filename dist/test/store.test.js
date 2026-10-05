"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const diff_1 = require("../src/diff");
const rules_1 = require("../src/rules");
const store_1 = require("../src/store");
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const DECISIONS = ['allow', 'deny', 'audit'];
const SOURCES = ['ops-console', 'sync-job', 'audit-import', 'emergency-push'];
function makeRule(seq, rand) {
    return {
        id: `rule-${seq}`,
        decision: DECISIONS[Math.floor(rand() * DECISIONS.length)] ?? 'allow',
        source: SOURCES[Math.floor(rand() * SOURCES.length)] ?? 'ops-console',
        pattern: `cidr:10.${Math.floor(rand() * 256)}.0.0/16`,
    };
}
function applyToRules(rules, diff) {
    const next = new Map(rules);
    for (const rule of diff.removed)
        next.delete(rule.id);
    for (const rule of diff.added)
        next.set(rule.id, rule);
    return next;
}
(0, node_test_1.default)('批量增删生成带前后摘要的差分', () => {
    const store = new store_1.PolicyStore();
    const first = store.plan([
        { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
        { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
    ]);
    strict_1.default.equal(first.before.ruleCount, 0);
    strict_1.default.equal(first.after.ruleCount, 2);
    strict_1.default.deepEqual(first.after.decisions, { allow: 1, deny: 1 });
    strict_1.default.deepEqual(first.after.sources, { s1: 1, s2: 1 });
    strict_1.default.deepEqual(first.added.map((r) => r.id), ['a', 'b']);
    strict_1.default.equal(first.removed.length, 0);
    store.publish(first);
    const second = store.plan([
        { kind: 'delete', id: 'a' },
        { kind: 'add', rule: { id: 'c', decision: 'audit', source: 's1', pattern: 'p3' } },
    ]);
    strict_1.default.equal(second.before.hash, first.after.hash);
    strict_1.default.equal(second.after.ruleCount, 2);
    strict_1.default.deepEqual(second.removed.map((r) => r.id), ['a']);
    strict_1.default.deepEqual(second.added.map((r) => r.id), ['c']);
    strict_1.default.deepEqual(second.after.decisions, { deny: 1, audit: 1 });
    store.publish(second);
    strict_1.default.equal(store.current.seq, 2);
});
(0, node_test_1.default)('先核后像：前像摘要不符则拒绝且不产生新版本', () => {
    const store = new store_1.PolicyStore();
    const diff = store.plan([
        { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
    ]);
    store.publish(diff);
    const stale = store.plan([
        { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
    ]);
    store.publish(stale);
    const before = store.length;
    strict_1.default.throws(() => store.publish(diff), store_1.DiffVerificationError);
    strict_1.default.equal(store.length, before);
    strict_1.default.equal(store.current.seq, 2);
    const forged = { ...stale, after: { ...stale.after, ruleCount: 99 } };
    strict_1.default.throws(() => store.publish(forged), store_1.DiffVerificationError);
    strict_1.default.equal(store.length, before);
});
(0, node_test_1.default)('历史版本不被后续发布改变', () => {
    const store = new store_1.PolicyStore();
    const summaries = [store.current.summary];
    for (let i = 0; i < 5; i += 1) {
        const diff = store.plan([
            { kind: 'add', rule: { id: `r${i}`, decision: 'allow', source: 's', pattern: `p${i}` } },
        ]);
        store.publish(diff);
        summaries.push(store.current.summary);
    }
    for (let seq = 0; seq < summaries.length; seq += 1) {
        const version = store.version(seq);
        strict_1.default.equal(version.summary.hash, summaries[seq]?.hash);
        strict_1.default.equal(version.summary.ruleCount, seq);
    }
    const v1 = store.version(1);
    strict_1.default.throws(() => {
        v1.rules.set('hack', {
            id: 'hack', decision: 'allow', source: 'x', pattern: 'y',
        });
    });
    strict_1.default.equal(store.version(1).summary.ruleCount, 1);
});
(0, node_test_1.default)('策略热更与读者快照隔离', () => {
    const store = new store_1.PolicyStore();
    store.publish(store.plan([
        { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
    ]));
    const reader = store.snapshot();
    strict_1.default.equal(reader.seq, 1);
    store.publish(store.plan([
        { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
        { kind: 'delete', id: 'a' },
    ]));
    strict_1.default.equal(store.current.seq, 2);
    strict_1.default.equal(reader.seq, 1);
    strict_1.default.equal(reader.has('a'), true);
    strict_1.default.equal(reader.has('b'), false);
    strict_1.default.equal(reader.get('a')?.decision, 'allow');
    strict_1.default.equal(store.current.rules.has('a'), false);
    strict_1.default.equal(store.current.rules.has('b'), true);
});
(0, node_test_1.default)('随机差分复合与逆放核对：决议及来源完全恢复', () => {
    const rand = mulberry32(20261005);
    const store = new store_1.PolicyStore();
    const initial = store.current.summary;
    const diffs = [];
    let ruleSeq = 0;
    for (let round = 0; round < 60; round += 1) {
        const batch = [];
        const working = new Set(store.current.rules.keys());
        const ops = 1 + Math.floor(rand() * 6);
        for (let i = 0; i < ops; i += 1) {
            const canDelete = working.size > 0;
            if (!canDelete || rand() < 0.6) {
                const rule = makeRule(ruleSeq, rand);
                ruleSeq += 1;
                working.add(rule.id);
                batch.push({ kind: 'add', rule });
            }
            else {
                const ids = [...working];
                const id = ids[Math.floor(rand() * ids.length)];
                if (id === undefined)
                    continue;
                working.delete(id);
                batch.push({ kind: 'delete', id });
            }
        }
        const diff = store.plan(batch);
        store.publish(diff);
        diffs.push(diff);
    }
    const baseSeq = store.current.seq - diffs.length;
    for (let attempt = 0; attempt < 300; attempt += 1) {
        const i = Math.floor(rand() * diffs.length);
        const j = i + Math.floor(rand() * (diffs.length - i));
        let composed = diffs[i];
        for (let k = i + 1; k <= j; k += 1) {
            const next = diffs[k];
            strict_1.default.ok(composed !== undefined && next !== undefined);
            composed = (0, diff_1.composeDiffs)(composed, next);
        }
        strict_1.default.ok(composed !== undefined);
        strict_1.default.equal(composed.before.hash, diffs[i]?.before.hash);
        strict_1.default.equal(composed.after.hash, diffs[j]?.after.hash);
        const startVersion = store.version(baseSeq + i);
        const landed = (0, rules_1.summarize)(applyToRules(startVersion.rules, composed));
        strict_1.default.equal(landed.hash, composed.after.hash);
        strict_1.default.equal(landed.ruleCount, composed.after.ruleCount);
        strict_1.default.deepEqual(landed.decisions, composed.after.decisions);
        strict_1.default.deepEqual(landed.sources, composed.after.sources);
    }
    const tipSnapshot = store.snapshot();
    for (let k = diffs.length - 1; k >= 0; k -= 1) {
        const diff = diffs[k];
        strict_1.default.ok(diff !== undefined);
        store.unpublish(diff);
    }
    strict_1.default.equal(store.current.seq, baseSeq + diffs.length * 2);
    strict_1.default.equal(store.current.summary.hash, initial.hash);
    strict_1.default.equal(store.current.summary.ruleCount, 0);
    strict_1.default.deepEqual(store.current.summary.decisions, {});
    strict_1.default.deepEqual(store.current.summary.sources, {});
    strict_1.default.equal(store.current.rules.size, 0);
    strict_1.default.equal(store.version(baseSeq).summary.hash, initial.hash);
    strict_1.default.equal(tipSnapshot.summary.hash, diffs[diffs.length - 1]?.after.hash);
    strict_1.default.equal(tipSnapshot.summary.ruleCount, diffs[diffs.length - 1]?.after.ruleCount);
});
(0, node_test_1.default)('逆放顺序错误时先核失败、库状态不变', () => {
    const store = new store_1.PolicyStore();
    const d1 = store.plan([
        { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
    ]);
    store.publish(d1);
    const d2 = store.plan([
        { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
    ]);
    store.publish(d2);
    const before = store.length;
    strict_1.default.throws(() => store.unpublish(d1), store_1.DiffVerificationError);
    strict_1.default.equal(store.length, before);
    store.unpublish(d2);
    store.unpublish(d1);
    strict_1.default.equal(store.current.seq, 4);
    strict_1.default.equal(store.current.rules.size, 0);
    strict_1.default.equal(store.current.summary.hash, store.version(0).summary.hash);
});
(0, node_test_1.default)('差分复合要求相邻且逆差分前后摘要互换', () => {
    const store = new store_1.PolicyStore();
    const d1 = store.plan([
        { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
    ]);
    store.publish(d1);
    const d2 = store.plan([
        { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
    ]);
    store.publish(d2);
    const d3 = store.plan([
        { kind: 'add', rule: { id: 'c', decision: 'audit', source: 's3', pattern: 'p3' } },
    ]);
    strict_1.default.throws(() => (0, diff_1.composeDiffs)(d1, d3), /not adjacent/);
    const inverse = (0, diff_1.invertDiff)(d2);
    strict_1.default.equal(inverse.before.hash, d2.after.hash);
    strict_1.default.equal(inverse.after.hash, d2.before.hash);
    strict_1.default.deepEqual(inverse.added, d2.removed);
    strict_1.default.deepEqual(inverse.removed, d2.added);
});
