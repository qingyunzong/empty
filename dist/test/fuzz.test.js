import { test } from "node:test";
import assert from "node:assert/strict";
import { AmountDocument, EditError, formatAmount, parseAmount, MAX_CENTS, } from "../src/index.js";
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
function randomCents(rand) {
    // 覆盖 0 .. MAX_CENTS 全量级
    const digits = 1 + Math.floor(rand() * 16);
    let s = "";
    for (let i = 0; i < digits; i++)
        s += Math.floor(rand() * 10);
    const v = BigInt(s);
    return v > MAX_CENTS ? v % (MAX_CENTS + 1n) : v;
}
function randomDigits(rand, maxLen) {
    const len = 1 + Math.floor(rand() * maxLen);
    let s = "";
    for (let i = 0; i < len; i++)
        s += Math.floor(rand() * 10);
    return s;
}
function assertSameDigits(doc, full) {
    assert.equal(doc.cents, full.cents);
    const mine = doc.digits();
    assert.equal(mine.length, full.digits.length, `digits length of ${doc.text}`);
    for (let i = 0; i < mine.length; i++) {
        assert.equal(mine[i].place, full.digits[i].place);
        assert.equal(mine[i].char, full.digits[i].char, `place ${i} of ${doc.text}`);
        assert.deepEqual(mine[i].sources.map((t) => t.raw), full.digits[i].sources.map((t) => t.raw), `sources of place ${i} of ${doc.text}`);
        // digitAt 与完整映射一致
        assert.equal(doc.digitAt(i).char, full.digits[i].char);
    }
}
for (const seed of [1, 42, 2026]) {
    test(`随机编辑与完整解析逐位映射核对 (seed=${seed})`, () => {
        const rand = mulberry32(seed);
        let doc = AmountDocument.create(formatAmount(randomCents(rand)));
        const snapshots = [];
        const remember = () => snapshots.push({ doc, text: doc.text, cents: doc.cents });
        remember();
        for (let step = 0; step < 400; step++) {
            const kinds = doc.segments.map((s) => s.kind);
            const target = rand();
            if (target < 0.12) {
                // 非法编辑：必须抛 EditError，且文档不变、不发布新快照
                const before = doc;
                assert.throws(() => {
                    const bad = rand();
                    const kind = kinds[Math.floor(rand() * kinds.length)];
                    const unitKind = doc.segments.find((g) => g.unit !== null)?.kind;
                    if (bad < 0.3) {
                        doc.setSegmentDigits(kind, randomDigits(rand, 3) + "xx"); // 非数字
                    }
                    else if (bad < 0.5) {
                        doc.setSegmentDigits(kind, ""); // 空段
                    }
                    else if (bad < 0.8 || unitKind === undefined) {
                        doc.setFraction(randomDigits(rand, 2) + "07"); // 3-4 位小数
                    }
                    else {
                        doc.setSegmentDigits(unitKind, randomDigits(rand, 2) + "00000"); // 单位段超 4 位
                    }
                }, (e) => e instanceof EditError, `step ${step}: invalid edit must throw`);
                assert.equal(doc, before);
                assert.equal(doc.cents, before.cents);
                continue;
            }
            if (target < 0.25 || kinds.length === 0) {
                // 小数编辑：设置/替换/删除
                if (doc.fraction !== null && rand() < 0.3) {
                    doc = doc.setFraction(null);
                }
                else {
                    doc = doc.setFraction(randomDigits(rand, 2));
                }
            }
            else {
                // 段编辑：1-4 位随机数字（允许零占位）
                const kind = kinds[Math.floor(rand() * kinds.length)];
                doc = doc.setSegmentDigits(kind, randomDigits(rand, 4));
            }
            // 词法结构保留原字节
            for (const t of doc.tokens) {
                assert.equal(doc.text.slice(t.start, t.end), t.raw, `token bytes at step ${step}`);
            }
            // 与完整解析逐位核对
            assertSameDigits(doc, parseAmount(doc.text));
            remember();
        }
        // 所有旧快照保持不变
        for (const snap of snapshots) {
            assert.equal(snap.doc.text, snap.text);
            assert.equal(snap.doc.cents, snap.cents);
        }
    });
}
