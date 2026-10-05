import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount,
  ParseError,
  type ParseErrorCode,
  type ParsedAmount,
} from "../src/index.js";

const YI = 100_000_000n;
const WAN = 10_000n;

function expectValid(text: string, expectedCents: bigint): ParsedAmount {
  const p = parseAmount(text);
  assert.equal(p.cents, expectedCents, `cents of ${JSON.stringify(text)}`);
  // 每位来源通用不变量：位数与分数字串一致，来源 token 指向原文原字节
  const s = expectedCents.toString();
  assert.equal(p.digits.length, s.length, `digits length of ${text}`);
  for (const d of p.digits) {
    assert.equal(d.char, s[s.length - 1 - d.place], `place ${d.place} of ${text}`);
    for (const tok of d.sources) {
      assert.equal(text.slice(tok.start, tok.end), tok.raw);
    }
  }
  return p;
}

function expectInvalid(text: string, code: ParseErrorCode): void {
  assert.throws(
    () => parseAmount(text),
    (e: unknown) => e instanceof ParseError && e.code === code,
    `expect ${code} for ${JSON.stringify(text)}`,
  );
}

test("基础整数值", () => {
  expectValid("0", 0n);
  expectValid("1", 100n);
  expectValid("9", 900n);
  expectValid("10", 1000n);
  expectValid("9999", 999_900n);
  expectValid("10000", 1_000_000n);
  expectValid("123456789012345", 12_345_678_901_234_500n); // 无单位整数不限长
});

test("零占位不改变量级", () => {
  expectValid("0000", 0n);
  expectValid("0001", 100n);
  expectValid("0001万", WAN * 100n);
  expectValid("1万0000", WAN * 100n);
  expectValid("1万0005", (WAN + 5n) * 100n);
  expectValid("10万00", 10n * WAN * 100n);
  expectValid("1亿0000万0001", (YI + 1n) * 100n);
  expectValid("0万0", 0n);
  expectValid("0.00", 0n);
  expectValid("0.0", 0n);
});

test("万亿段组合", () => {
  expectValid("1万", WAN * 100n);
  expectValid("9999万", 9999n * WAN * 100n);
  expectValid("1亿", YI * 100n);
  expectValid("1亿1", (YI + 1n) * 100n);
  expectValid("1亿2万", (YI + 2n * WAN) * 100n);
  expectValid("12亿345万6789", (12n * YI + 345n * WAN + 6789n) * 100n);
  expectValid("9999亿9999万9999", 99_999_999_999_900n);
});

test("小数位", () => {
  expectValid("0.01", 1n);
  expectValid("0.99", 99n);
  expectValid("0.5", 50n);
  expectValid("1.05", 105n);
  expectValid("1.5", 150n);
  expectValid("1万.5", WAN * 100n + 50n);
  expectValid("9999亿9999万9999.99", 99_999_999_999_999n);
});

test("每位来源：token 精确定位", () => {
  const p = expectValid("12亿345万6789.01", 120_345_678_901n);
  // cents = 120345678901，共 12 位
  assert.equal(p.digits.length, 12);
  const src = (place: number) => p.digits[place]!.sources.map((t) => t.raw);
  assert.deepEqual(src(0), ["01"]); // 分位
  assert.deepEqual(src(1), ["01"]); // 角位
  assert.deepEqual(src(2), ["6789"]); // 个段
  assert.deepEqual(src(5), ["6789"]);
  assert.deepEqual(src(6), ["345", "万"]); // 万段（含单位来源）
  assert.deepEqual(src(8), ["345", "万"]);
  assert.deepEqual(src(9), []); // 隐式零：345万 仅占元位 4..6，元位 7 无段覆盖
  assert.deepEqual(src(10), ["12", "亿"]); // 亿段
  assert.deepEqual(src(11), ["12", "亿"]);
  assert.equal(p.digits[2]!.char, "9");
  assert.equal(p.digits[6]!.char, "5");
  assert.equal(p.digits[10]!.char, "2");
  assert.equal(p.digits[11]!.char, "1");
});

test("每位来源：隐式零无来源", () => {
  const p = expectValid("1亿", YI * 100n);
  // cents = 10000000000，place 0..9 全为 0
  assert.deepEqual(p.digits[0]!.sources, []);
  assert.deepEqual(p.digits[5]!.sources, []);
  assert.deepEqual(p.digits[9]!.sources, []);
  assert.deepEqual(p.digits[10]!.sources.map((t) => t.raw), ["1", "亿"]);
  const q = expectValid("1万0005", (WAN + 5n) * 100n);
  // cents = 1000500：place 2..5 来自个段 "0005"（含零占位），place 6 来自万段
  assert.deepEqual(q.digits[2]!.sources.map((t) => t.raw), ["0005"]);
  assert.deepEqual(q.digits[5]!.sources.map((t) => t.raw), ["0005"]);
  assert.deepEqual(q.digits[6]!.sources.map((t) => t.raw), ["1", "万"]);
});

test("非法串：空与缺数字", () => {
  expectInvalid("", "NO_DIGITS");
  expectInvalid(".5", "NO_DIGITS");
  expectInvalid("万", "MISSING_DIGITS_BEFORE_UNIT");
  expectInvalid("亿", "MISSING_DIGITS_BEFORE_UNIT");
  expectInvalid("万亿", "MISSING_DIGITS_BEFORE_UNIT");
  expectInvalid("1亿万", "MISSING_DIGITS_BEFORE_UNIT");
});

test("非法串：重复单位与单位顺序", () => {
  expectInvalid("1万2万", "DUPLICATE_UNIT");
  expectInvalid("1亿2亿", "DUPLICATE_UNIT");
  expectInvalid("1万2万3", "DUPLICATE_UNIT");
  expectInvalid("1亿2亿3万", "DUPLICATE_UNIT");
  expectInvalid("1万2亿", "UNIT_ORDER");
  expectInvalid("1万2亿3", "UNIT_ORDER");
  expectInvalid("1万2亿3万", "UNIT_ORDER");
});

test("非法串：段过长", () => {
  expectInvalid("12345万", "SEGMENT_TOO_LONG");
  expectInvalid("12345亿", "SEGMENT_TOO_LONG");
  expectInvalid("1万12345", "SEGMENT_TOO_LONG");
  expectInvalid("1亿2万12345", "SEGMENT_TOO_LONG");
  expectInvalid("10000万", "SEGMENT_TOO_LONG"); // 与 "9999万" 构成边界对
});

test("非法串：小数", () => {
  expectInvalid("1.", "MISSING_FRACTION");
  expectInvalid("1万.", "MISSING_FRACTION");
  expectInvalid("1..2", "MISSING_FRACTION");
  expectInvalid(".", "MISSING_FRACTION");
  expectInvalid("1.234", "FRACTION_TOO_LONG");
  expectInvalid("1.005", "FRACTION_TOO_LONG");
});

test("非法串：多余 token 与非法字符", () => {
  expectInvalid("1.2.3", "UNEXPECTED_TOKEN");
  expectInvalid("1.2万", "UNEXPECTED_TOKEN");
  expectInvalid("1万2.3.4", "UNEXPECTED_TOKEN");
  expectInvalid("abc", "INVALID_CHAR");
  expectInvalid("一万", "INVALID_CHAR");
  expectInvalid("１２３", "INVALID_CHAR");
  expectInvalid("1,000", "INVALID_CHAR");
  expectInvalid("-1", "INVALID_CHAR");
  expectInvalid("+1", "INVALID_CHAR");
  expectInvalid("1e5", "INVALID_CHAR");
  expectInvalid("1 万", "INVALID_CHAR");
  expectInvalid("1元", "INVALID_CHAR");
  expectInvalid("1.2x", "INVALID_CHAR");
});
