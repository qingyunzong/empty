import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, ParseError, } from "../src/index.js";
const YI = 100000000n;
const WAN = 10000n;
const DIGIT_SAMPLES = ["0", "1", "9", "10", "999", "1000", "9999", "0000", "0001", "0100"];
const FRACS = [null, ".0", ".5", ".05", ".99", ".00"];
function fracCents(frac) {
    if (frac === null)
        return 0n;
    const f = frac.slice(1);
    return BigInt(f) * (f.length === 1 ? 10n : 1n);
}
/** 独立参考实现：按构造直接计算期望值（不经过被测解析器）。 */
function expectedCents(parts, frac) {
    let yuan = 0n;
    for (const p of parts)
        yuan += BigInt(p.digits) * p.scale;
    return yuan * 100n + fracCents(frac);
}
function checkValid(text, expected) {
    let p;
    try {
        p = parseAmount(text);
    }
    catch (e) {
        assert.fail(`应当合法却拒绝 ${JSON.stringify(text)}: ${e.message}`);
    }
    assert.equal(p.cents, expected, `cents of ${JSON.stringify(text)}`);
    // token 拼接即原文（词法结构保留原字节）
    assert.equal(p.tokens.map((t) => t.raw).join(""), text);
    // 每位来源：非零位必有来源；来源 token 指向原文
    for (const d of p.digits) {
        if (d.char !== "0") {
            assert.ok(d.sources.length > 0, `非零位缺来源: ${text} place ${d.place}`);
        }
        for (const t of d.sources) {
            assert.equal(text.slice(t.start, t.end), t.raw);
        }
    }
}
function checkInvalid(text, code) {
    assert.throws(() => parseAmount(text), (e) => e instanceof ParseError && e.code === code, `expect ${code} for ${JSON.stringify(text)}`);
}
test("穷举验收：无单位整数 × 小数", () => {
    const extras = ["12345", "999999999999", "00000"];
    for (const ge of [...DIGIT_SAMPLES, ...extras]) {
        for (const frac of FRACS) {
            const text = ge + (frac ?? "");
            checkValid(text, expectedCents([{ digits: ge, scale: 1n }], frac));
        }
    }
});
test("穷举验收：万段 × 个段(可缺省) × 小数", () => {
    for (const wan of DIGIT_SAMPLES) {
        for (const ge of [...DIGIT_SAMPLES, null]) {
            for (const frac of FRACS) {
                const parts = [{ digits: wan, scale: WAN }];
                let text = `${wan}万`;
                if (ge !== null) {
                    parts.push({ digits: ge, scale: 1n });
                    text += ge;
                }
                text += frac ?? "";
                checkValid(text, expectedCents(parts, frac));
            }
        }
    }
});
test("穷举验收：亿段 × 个段(可缺省) × 小数", () => {
    for (const yi of DIGIT_SAMPLES) {
        for (const ge of [...DIGIT_SAMPLES, null]) {
            for (const frac of FRACS) {
                const parts = [{ digits: yi, scale: YI }];
                let text = `${yi}亿`;
                if (ge !== null) {
                    parts.push({ digits: ge, scale: 1n });
                    text += ge;
                }
                text += frac ?? "";
                checkValid(text, expectedCents(parts, frac));
            }
        }
    }
});
test("穷举验收：亿段 × 万段 × 个段(可缺省) × 小数", () => {
    for (const yi of DIGIT_SAMPLES) {
        for (const wan of DIGIT_SAMPLES) {
            for (const ge of [...DIGIT_SAMPLES, null]) {
                for (const frac of FRACS) {
                    const parts = [
                        { digits: yi, scale: YI },
                        { digits: wan, scale: WAN },
                    ];
                    let text = `${yi}亿${wan}万`;
                    if (ge !== null) {
                        parts.push({ digits: ge, scale: 1n });
                        text += ge;
                    }
                    text += frac ?? "";
                    checkValid(text, expectedCents(parts, frac));
                }
            }
        }
    }
});
test("穷举拒绝：重复单位（全组合）", () => {
    for (const a of DIGIT_SAMPLES) {
        for (const b of DIGIT_SAMPLES) {
            checkInvalid(`${a}万${b}万`, "DUPLICATE_UNIT");
            checkInvalid(`${a}亿${b}亿`, "DUPLICATE_UNIT");
            checkInvalid(`${a}万${b}万5`, "DUPLICATE_UNIT");
            checkInvalid(`${a}亿${b}亿5.5`, "DUPLICATE_UNIT");
        }
    }
});
test("穷举拒绝：单位递增（全组合）", () => {
    for (const a of DIGIT_SAMPLES) {
        for (const b of DIGIT_SAMPLES) {
            checkInvalid(`${a}万${b}亿`, "UNIT_ORDER");
            checkInvalid(`${a}万${b}亿1`, "UNIT_ORDER");
            checkInvalid(`${a}万${b}亿1万`, "UNIT_ORDER");
            checkInvalid(`${a}万${b}亿1.5`, "UNIT_ORDER");
        }
    }
});
test("穷举拒绝：段过长", () => {
    const five = ["10000", "00000", "99999", "12345"];
    for (const d of five) {
        checkInvalid(`${d}万`, "SEGMENT_TOO_LONG");
        checkInvalid(`${d}亿`, "SEGMENT_TOO_LONG");
        checkInvalid(`1万${d}`, "SEGMENT_TOO_LONG");
        checkInvalid(`1亿${d}`, "SEGMENT_TOO_LONG");
        checkInvalid(`1亿2万${d}`, "SEGMENT_TOO_LONG");
        checkInvalid(`1亿${d}万`, "SEGMENT_TOO_LONG");
    }
});
test("穷举拒绝：缺数字 / 缺小数 / 小数过长 / 多余 token", () => {
    const missingDigits = ["万", "亿", "万亿", "亿万", "1亿万", "1万亿"];
    for (const t of missingDigits)
        checkInvalid(t, "MISSING_DIGITS_BEFORE_UNIT");
    const missingFrac = ["1.", "1万.", "1亿2万3.", "1..2", "."];
    for (const t of missingFrac)
        checkInvalid(t, "MISSING_FRACTION");
    const longFrac = ["1.234", "0.000", "1万2.345", "9999亿9999万9999.999"];
    for (const t of longFrac)
        checkInvalid(t, "FRACTION_TOO_LONG");
    const unexpected = ["1.2.3", "1.2万", "1.2亿", "1万2.3.4", "1.2万3", "1.2."];
    for (const t of unexpected)
        checkInvalid(t, "UNEXPECTED_TOKEN");
    const noDigits = ["", ".5", ".05"];
    for (const t of noDigits)
        checkInvalid(t, "NO_DIGITS");
});
test("穷举拒绝：非法字符", () => {
    const badChars = ["一", "１", "-", "+", ",", " ", "e", "元", "$", "千", "百", "零", "\t", "\n"];
    for (const c of badChars) {
        checkInvalid(c, "INVALID_CHAR");
        checkInvalid(`1${c}`, "INVALID_CHAR");
        checkInvalid(`1万${c}`, "INVALID_CHAR");
        checkInvalid(`${c}1万`, "INVALID_CHAR");
        checkInvalid(`1.2${c}`, "INVALID_CHAR");
    }
});
test("边界对：9999/10000 临界", () => {
    checkValid("9999", 999900n);
    checkValid("10000", 1000000n); // 无单位整数不受 4 位限制
    checkValid("9999万", 9999n * WAN * 100n);
    checkInvalid("10000万", "SEGMENT_TOO_LONG");
    checkValid("9999亿", 9999n * YI * 100n);
    checkInvalid("10000亿", "SEGMENT_TOO_LONG");
    checkValid("9999亿9999万9999.99", 99999999999999n); // 定义域最大值
    checkValid("0.01", 1n); // 最小非零值
    checkValid("0", 0n); // 最小值
});
