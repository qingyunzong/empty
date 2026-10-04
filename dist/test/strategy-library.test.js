import test from "node:test";
import assert from "node:assert/strict";
import { applyDiffChecked, composeDiffs, DiffVerificationError, digestOf, invertDiff, StrategyLibrary, summarizeRule, } from "../src/strategy-library.js";
function rule(id, decision, source) {
    return { id, decision, source };
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function snapshotModel(lib, versionId) {
    const snap = lib.getSnapshot(versionId);
    const model = new Map();
    for (const r of snap.listRules())
        model.set(r.id, { id: r.id, decision: r.decision, source: r.source });
    return model;
}
test("批量增删发布生成带前后摘要的差分", () => {
    const lib = new StrategyLibrary();
    const v1 = lib.publish([
        { type: "put", rule: rule("a", "allow", "policy-1") },
        { type: "put", rule: rule("b", "deny", "policy-2") },
    ]);
    assert.equal(v1.diff.entries.length, 2);
    for (const entry of v1.diff.entries) {
        assert.equal(entry.op, "add");
        assert.equal(entry.before, null);
        assert.ok(entry.after);
        assert.equal(entry.after.hash, summarizeRule(rule(entry.ruleId, entry.after.decision, entry.after.source)).hash);
    }
    const v2 = lib.publish([
        { type: "put", rule: rule("a", "allow-with-mfa", "policy-1") },
        { type: "delete", ruleId: "b" },
        { type: "put", rule: rule("c", "audit", "policy-3") },
    ]);
    const byId = new Map(v2.diff.entries.map((e) => [e.ruleId, e]));
    const upd = byId.get("a");
    assert.ok(upd);
    assert.equal(upd.op, "update");
    assert.equal(upd.before?.decision, "allow");
    assert.equal(upd.before?.source, "policy-1");
    assert.equal(upd.after?.decision, "allow-with-mfa");
    const del = byId.get("b");
    assert.ok(del);
    assert.equal(del.op, "delete");
    assert.equal(del.before?.decision, "deny");
    assert.equal(del.after, null);
    const add = byId.get("c");
    assert.ok(add);
    assert.equal(add.op, "add");
    assert.equal(add.after?.source, "policy-3");
    assert.equal(v2.diff.fromDigest, v1.digest);
    assert.equal(v2.diff.toDigest, v2.digest);
});
test("历史版本不可变：发布后旧版本指纹与内容不变且被冻结", () => {
    const lib = new StrategyLibrary();
    const v1 = lib.publish([{ type: "put", rule: rule("a", "d1", "s1") }]);
    const digestBefore = v1.digest;
    const diffBefore = JSON.parse(JSON.stringify(v1.diff));
    lib.publish([{ type: "put", rule: rule("a", "d2", "s2") }]);
    lib.inversePublish(1);
    const v1After = lib.getVersion(1);
    assert.equal(v1After.digest, digestBefore);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(v1After.diff)), diffBefore);
    assert.ok(Object.isFrozen(v1After));
    assert.ok(Object.isFrozen(v1After.diff));
    assert.ok(Object.isFrozen(v1After.diff.entries));
    assert.equal(lib.getSnapshot(1).decide("a"), "d1");
});
test("策略热更与读者快照隔离", () => {
    const lib = new StrategyLibrary();
    lib.publish([
        { type: "put", rule: rule("a", "allow", "src-a") },
        { type: "put", rule: rule("b", "deny", "src-b") },
    ]);
    const reader = lib.getSnapshot();
    lib.publish([
        { type: "put", rule: rule("a", "deny", "src-a2") },
        { type: "delete", ruleId: "b" },
        { type: "put", rule: rule("c", "audit", "src-c") },
    ]);
    assert.equal(reader.decide("a"), "allow");
    assert.equal(reader.decide("b"), "deny");
    assert.equal(reader.has("c"), false);
    assert.equal(reader.size, 2);
    assert.ok(Object.isFrozen(reader));
    assert.ok(Object.isFrozen(reader.getRule("a")));
    const head = lib.getSnapshot();
    assert.equal(head.decide("a"), "deny");
    assert.equal(head.has("b"), false);
    assert.equal(head.decide("c"), "audit");
});
test("逆发布先核后像：决议与来源完全恢复，历史只增不改", () => {
    const lib = new StrategyLibrary();
    lib.publish([
        { type: "put", rule: rule("a", "allow", "src-1") },
        { type: "put", rule: rule("b", "deny", "src-2") },
    ]);
    lib.publish([{ type: "put", rule: rule("a", "allow-mfa", "src-1b") }]);
    lib.publish([
        { type: "delete", ruleId: "b" },
        { type: "put", rule: rule("c", "audit", "src-3") },
    ]);
    const countBefore = lib.versionCount;
    const headBefore = lib.head.id;
    const restored = lib.inversePublish(1);
    assert.equal(restored.id, headBefore + 1);
    assert.equal(lib.versionCount, countBefore + 1);
    assert.equal(restored.digest, lib.getVersion(1).digest);
    const snap = lib.getSnapshot();
    assert.equal(snap.decide("a"), "allow");
    assert.equal(snap.getRule("a")?.source, "src-1");
    assert.equal(snap.decide("b"), "deny");
    assert.equal(snap.getRule("b")?.source, "src-2");
    assert.equal(snap.has("c"), false);
    assert.deepStrictEqual(snapshotModel(lib), snapshotModel(lib, 1));
    // 历史版本未被改写
    assert.equal(lib.getVersion(2).diff.entries[0]?.after?.decision, "allow-mfa");
    assert.equal(lib.getVersion(3).digest, lib.getVersion(3).digest);
});
test("逆发布目标非法时抛错且历史不变", () => {
    const lib = new StrategyLibrary();
    lib.publish([{ type: "put", rule: rule("a", "d", "s") }]);
    const count = lib.versionCount;
    assert.throws(() => lib.inversePublish(1), RangeError);
    assert.throws(() => lib.inversePublish(99), RangeError);
    assert.equal(lib.versionCount, count);
});
test("差分校验：前置摘要或指纹被篡改时拒绝应用（先核）", () => {
    const lib = new StrategyLibrary();
    lib.publish([{ type: "put", rule: rule("a", "d1", "s1") }]);
    const v2 = lib.publish([{ type: "put", rule: rule("a", "d2", "s2") }]);
    const base = snapshotModel(lib, 1);
    const ok = applyDiffChecked(base, v2.diff);
    assert.equal(ok.get("a")?.decision, "d2");
    const tamperedBefore = {
        ...v2.diff,
        entries: v2.diff.entries.map((e) => ({
            ...e,
            before: e.before === null ? null : { ...e.before, decision: "forged" },
        })),
    };
    assert.throws(() => applyDiffChecked(base, tamperedBefore), DiffVerificationError);
    const tamperedDigest = { ...v2.diff, toDigest: "0".repeat(64) };
    assert.throws(() => applyDiffChecked(base, tamperedDigest), DiffVerificationError);
    const wrongBase = { ...v2.diff, fromDigest: "f".repeat(64) };
    assert.throws(() => applyDiffChecked(base, wrongBase), DiffVerificationError);
});
test("差分复合：compose 等价于顺序应用", () => {
    const lib = new StrategyLibrary();
    lib.publish([{ type: "put", rule: rule("a", "d1", "s1") }]);
    lib.publish([
        { type: "put", rule: rule("a", "d2", "s2") },
        { type: "put", rule: rule("b", "db", "sb") },
    ]);
    lib.publish([
        { type: "delete", ruleId: "a" },
        { type: "put", rule: rule("b", "db2", "sb2") },
    ]);
    const d12 = composeDiffs(lib.getVersion(1).diff, lib.getVersion(2).diff);
    const d123 = composeDiffs(d12, lib.getVersion(3).diff);
    assert.equal(d123.fromDigest, lib.getVersion(0).digest);
    assert.equal(d123.toDigest, lib.getVersion(3).digest);
    // a 增后又删：净效果消去；b 两次更新合并为一条
    assert.equal(d123.entries.length, 1);
    assert.equal(d123.entries[0]?.ruleId, "b");
    assert.equal(d123.entries[0]?.op, "add");
    assert.equal(d123.entries[0]?.after?.decision, "db2");
    const applied = applyDiffChecked(new Map(), d123);
    assert.equal(digestOf(applied), lib.getVersion(3).digest);
});
test("随机化：差分复合与逆发布完全恢复决议及来源", () => {
    const rng = mulberry32(0xc0ffee);
    const pick = (items) => items[Math.floor(rng() * items.length)];
    const keySpace = Array.from({ length: 12 }, (_, i) => `rule-${i}`);
    let nonce = 0;
    const randomRule = (id) => rule(id, `decision-${nonce++}-${Math.floor(rng() * 1e6)}`, `source-${Math.floor(rng() * 1e6)}`);
    for (let round = 0; round < 40; round++) {
        const lib = new StrategyLibrary();
        const modelHistory = [new Map()];
        const publishCount = 1 + Math.floor(rng() * 12);
        for (let p = 0; p < publishCount; p++) {
            const ops = [];
            const opCount = 1 + Math.floor(rng() * 8);
            for (let o = 0; o < opCount; o++) {
                const id = pick(keySpace);
                const current = modelHistory[modelHistory.length - 1];
                if (rng() < 0.35 && current.has(id)) {
                    ops.push({ type: "delete", ruleId: id });
                }
                else {
                    ops.push({ type: "put", rule: randomRule(id) });
                }
            }
            let published;
            try {
                published = lib.publish(ops);
            }
            catch {
                continue; // 同批内先删后删等非法序列：跳过，模型不变
            }
            const model = new Map(modelHistory[modelHistory.length - 1]);
            for (const op of ops) {
                if (op.type === "put")
                    model.set(op.rule.id, op.rule);
                else
                    model.delete(op.ruleId);
            }
            modelHistory.push(model);
            assert.equal(published.digest, digestOf(model));
            assert.deepStrictEqual(snapshotModel(lib), model);
        }
        // 随机差分复合：任取相邻区间，复合后应用 == 顺序应用
        if (lib.head.id >= 2) {
            const from = Math.floor(rng() * (lib.head.id - 1));
            const to = from + 1 + Math.floor(rng() * (lib.head.id - from));
            let composed = lib.getVersion(from + 1).diff;
            for (let v = from + 2; v <= to; v++)
                composed = composeDiffs(composed, lib.getVersion(v).diff);
            const baseModel = modelHistory[from];
            const applied = applyDiffChecked(baseModel, composed);
            assert.deepStrictEqual(applied, modelHistory[to]);
            assert.equal(digestOf(applied), lib.getVersion(to).digest);
            // 复合差分与逐段顺序应用结果一致
            let sequential = new Map(baseModel);
            for (let v = from + 1; v <= to; v++)
                sequential = applyDiffChecked(sequential, lib.getVersion(v).diff);
            assert.deepStrictEqual(applied, sequential);
        }
        // 随机逆发布：决议与来源完全恢复
        if (lib.head.id >= 1) {
            const target = Math.floor(rng() * lib.head.id);
            const countBefore = lib.versionCount;
            const restored = lib.inversePublish(target);
            assert.equal(lib.versionCount, countBefore + 1);
            assert.equal(restored.digest, lib.getVersion(target).digest);
            assert.deepStrictEqual(snapshotModel(lib), modelHistory[target]);
            // 逆差分自身也满足先核后放
            const undoAgain = applyDiffChecked(snapshotModel(lib, restored.id - 1), restored.diff);
            assert.deepStrictEqual(undoAgain, modelHistory[target]);
            // 历史版本未被改变
            for (let v = 0; v < countBefore; v++) {
                assert.equal(lib.getVersion(v).digest, digestOf(modelHistory[v]));
            }
        }
    }
});
test("逆差分结构：invert 后再应用回到原点", () => {
    const lib = new StrategyLibrary();
    lib.publish([
        { type: "put", rule: rule("x", "dx", "sx") },
        { type: "put", rule: rule("y", "dy", "sy") },
    ]);
    const v2 = lib.publish([
        { type: "put", rule: rule("x", "dx2", "sx2") },
        { type: "delete", ruleId: "y" },
    ]);
    const inverse = invertDiff(v2.diff);
    assert.equal(inverse.fromDigest, v2.digest);
    assert.equal(inverse.toDigest, lib.getVersion(1).digest);
    const restored = applyDiffChecked(snapshotModel(lib, 2), inverse);
    assert.equal(restored.get("x")?.decision, "dx");
    assert.equal(restored.get("x")?.source, "sx");
    assert.equal(restored.get("y")?.decision, "dy");
    assert.equal(restored.get("y")?.source, "sy");
});
