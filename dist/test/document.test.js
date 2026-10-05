import { test } from "node:test";
import assert from "node:assert/strict";
import { AmountDocument, EditError } from "../src/index.js";
test("词法结构保留原字节与单位来源", () => {
    const doc = AmountDocument.create("12亿345万6789.01");
    assert.equal(doc.cents, 120345678901n);
    for (const t of doc.tokens) {
        assert.equal(doc.text.slice(t.start, t.end), t.raw);
    }
    // 万/亿为 3 字节 UTF-8，字节区间正确
    const yi = doc.segment("yi");
    assert.equal(yi.unit.raw, "亿");
    assert.equal(yi.unit.byteEnd - yi.unit.byteStart, 3);
    assert.equal(yi.digits.raw, "12");
    const wan = doc.segment("wan");
    assert.equal(wan.unit.raw, "万");
    assert.equal(wan.digits.raw, "345");
    assert.equal(doc.segment("ge").digits.raw, "6789");
    assert.equal(doc.fraction.raw, "01");
});
test("编辑万亿段：仅重算受影响段，其余段结构共享", () => {
    const doc1 = AmountDocument.create("12亿345万6789.01");
    const doc2 = doc1.setSegmentDigits("wan", "9999");
    assert.equal(doc2.text, "12亿9999万6789.01");
    assert.equal(doc2.cents, 129999678901n);
    // 编辑点之前的段对象同一引用（未被重算）
    assert.equal(doc2.segments[0], doc1.segments[0]); // 亿段
    // 编辑点之后的段：token 平移换新对象，但缓存 value 复用（不重算）
    assert.notEqual(doc2.segments[2], doc1.segments[2]); // 个段
    assert.equal(doc2.segments[2].value, doc1.segments[2].value);
    assert.notEqual(doc2.segments[1], doc1.segments[1]); // 万段被重算
    // 小数 token 在编辑点之后：平移为新对象，原字节不变
    assert.notEqual(doc2.fraction, doc1.fraction);
    assert.equal(doc2.fraction.raw, doc1.fraction.raw);
    assert.equal(doc2.fraction.start, doc1.fraction.start + 1);
    // 编辑点之前的 token 复用，之后的 token 平移但原字节不变
    assert.equal(doc2.tokens[0], doc1.tokens[0]);
    for (const t of doc2.tokens) {
        assert.equal(doc2.text.slice(t.start, t.end), t.raw);
    }
    // 旧快照不变
    assert.equal(doc1.text, "12亿345万6789.01");
    assert.equal(doc1.cents, 120345678901n);
});
test("编辑亿段与个段", () => {
    const doc1 = AmountDocument.create("1亿0005");
    const doc2 = doc1.setSegmentDigits("yi", "23");
    assert.equal(doc2.text, "23亿0005");
    assert.equal(doc2.cents, 230000000500n);
    const doc3 = doc2.setSegmentDigits("ge", "9999");
    assert.equal(doc3.text, "23亿9999");
    assert.equal(doc3.cents, 230000999900n);
    assert.equal(doc1.cents, 10000000500n); // 旧快照不变
});
test("小数段编辑：设置、替换、删除", () => {
    const doc1 = AmountDocument.create("1万");
    const doc2 = doc1.setFraction("5");
    assert.equal(doc2.text, "1万.5");
    assert.equal(doc2.cents, 1000050n);
    const doc3 = doc2.setFraction("99");
    assert.equal(doc3.text, "1万.99");
    assert.equal(doc3.cents, 1000099n);
    const doc4 = doc3.setFraction(null);
    assert.equal(doc4.text, "1万");
    assert.equal(doc4.cents, 1000000n);
    assert.equal(doc1.text, "1万");
});
test("查询某金额位由哪些原 token 决定", () => {
    const doc = AmountDocument.create("12亿345万6789.01");
    const raws = (place) => doc.digitAt(place).sources.map((t) => t.raw);
    assert.deepEqual(raws(0), ["01"]);
    assert.deepEqual(raws(2), ["6789"]);
    assert.deepEqual(raws(6), ["345", "万"]);
    assert.deepEqual(raws(10), ["12", "亿"]);
    // 编辑万段后，受影响位的来源指向新 token，其余位来源不变
    const doc2 = doc.setSegmentDigits("wan", "40");
    assert.equal(doc2.text, "12亿40万6789.01");
    assert.deepEqual(doc2.digitAt(6).sources.map((t) => t.raw), ["40", "万"]);
    assert.deepEqual(doc2.digitAt(2).sources.map((t) => t.raw), ["6789"]);
    // 编辑点之前的原 token 复用（对象同一）
    assert.equal(doc2.digitAt(10).sources[0], doc.digitAt(10).sources[0]);
    // 隐式零位无来源
    const doc3 = AmountDocument.create("1亿");
    assert.deepEqual(doc3.digitAt(5).sources, []);
    assert.throws(() => doc.digitAt(99), RangeError);
});
test("错误编辑不发布：抛错且旧快照不变", () => {
    const doc = AmountDocument.create("12亿345万6789.01");
    const bad = [
        () => doc.setSegmentDigits("wan", "12345"), // 超 4 位
        () => doc.setSegmentDigits("wan", "12a4"), // 非数字
        () => doc.setSegmentDigits("wan", ""), // 空
        () => doc.setSegmentDigits("yi", "00000"),
        () => doc.setFraction("123"), // 超两位
        () => doc.setFraction("x"),
        () => doc.setFraction(""),
    ];
    for (const fn of bad) {
        assert.throws(fn, (e) => e instanceof EditError);
    }
    assert.equal(doc.text, "12亿345万6789.01");
    assert.equal(doc.cents, 120345678901n);
    // 编辑不存在的段
    const plain = AmountDocument.create("100");
    assert.throws(() => plain.setSegmentDigits("wan", "1"), EditError);
    assert.throws(() => plain.setFraction(null), EditError);
    assert.equal(plain.text, "100");
    // 失败之后仍可正常编辑
    const ok = doc.setSegmentDigits("ge", "0001");
    assert.equal(ok.text, "12亿345万0001.01");
    assert.equal(ok.cents, 120345000101n);
});
test("无单位整数的个段可任意长", () => {
    const doc = AmountDocument.create("123456789");
    const doc2 = doc.setSegmentDigits("ge", "12345678901234567890");
    assert.equal(doc2.cents, 1234567890123456789000n);
    const withUnit = AmountDocument.create("1万2");
    assert.throws(() => withUnit.setSegmentDigits("ge", "12345"), EditError);
});
