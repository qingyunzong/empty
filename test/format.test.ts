import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, parseAmount, MAX_CENTS } from "../src/index.js";

test("规范形输出", () => {
  const cases: Array<[bigint, string]> = [
    [0n, "0"],
    [1n, "0.01"],
    [5n, "0.05"],
    [50n, "0.5"],
    [99n, "0.99"],
    [100n, "1"],
    [101n, "1.01"],
    [150n, "1.5"],
    [999_900n, "9999"],
    [1_000_000n, "1万"],
    [1_000_500n, "1万0005"],
    [1_000_050n, "1万.5"],
    [100_050_000n, "100万0500"],
    [10_000_000_000n, "1亿"],
    [10_000_000_500n, "1亿0005"],
    [10_001_000_000n, "1亿0001万"],
    [10_010_010_000n, "1亿0010万0100"],
    [99_999_999_999_900n, "9999亿9999万9999"],
    [MAX_CENTS, "9999亿9999万9999.99"],
  ];
  for (const [cents, text] of cases) {
    assert.equal(formatAmount(cents), text, `format ${cents}`);
  }
});

test("逆函数：parse ∘ format = id，format ∘ parse ∘ format = format", () => {
  const boundary: bigint[] = [
    0n, 1n, 5n, 9n, 10n, 50n, 99n, 100n, 101n, 110n, 999n, 1000n,
    9999n, 10000n, 999_999n, 1_000_000n, 1_000_001n, 1_000_050n,
    99_999_999n, 100_000_000n, 9_999_999_999n, 10_000_000_000n,
    10_000_000_001n, 999_999_999_999n, 1_000_000_000_000n,
    99_999_999_999_900n, MAX_CENTS - 1n, MAX_CENTS,
  ];
  for (const c of boundary) {
    const text = formatAmount(c);
    assert.equal(parseAmount(text).cents, c, `roundtrip ${c} via ${text}`);
    assert.equal(formatAmount(parseAmount(text).cents), text, `canonical ${text}`);
  }
});

test("逆函数：随机分值穷举往返", () => {
  let state = 0x9e3779b9n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return state;
  };
  for (let i = 0; i < 3000; i++) {
    const c = next() % (MAX_CENTS + 1n);
    const text = formatAmount(c);
    assert.equal(parseAmount(text).cents, c, `roundtrip ${c} via ${text}`);
  }
});

test("定义域外拒绝", () => {
  assert.throws(() => formatAmount(-1n), RangeError);
  assert.throws(() => formatAmount(MAX_CENTS + 1n), RangeError);
});
