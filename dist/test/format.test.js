import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, parseAmount, MAX_CENTS } from "../src/index.js";
test("规范形输出", () => {
    const cases = [
        [0n, "0"],
        [1n, "0.01"],
        [5n, "0.05"],
        [50n, "0.5"],
        [99n, "0.99"],
        [100n, "1"],
        [101n, "1.01"],
        [150n, "1.5"],
        [999900n, "9999"],
        [1000000n, "1万"],
        [1000500n, "1万0005"],
        [1000050n, "1万.5"],
        [100050000n, "100万0500"],
        [10000000000n, "1亿"],
        [10000000500n, "1亿0005"],
        [10001000000n, "1亿0001万"],
        [10010010000n, "1亿0010万0100"],
        [99999999999900n, "9999亿9999万9999"],
        [MAX_CENTS, "9999亿9999万9999.99"],
    ];
    for (const [cents, text] of cases) {
        assert.equal(formatAmount(cents), text, `format ${cents}`);
    }
});
test("逆函数：parse ∘ format = id，format ∘ parse ∘ format = format", () => {
    const boundary = [
        0n, 1n, 5n, 9n, 10n, 50n, 99n, 100n, 101n, 110n, 999n, 1000n,
        9999n, 10000n, 999999n, 1000000n, 1000001n, 1000050n,
        99999999n, 100000000n, 9999999999n, 10000000000n,
        10000000001n, 999999999999n, 1000000000000n,
        99999999999900n, MAX_CENTS - 1n, MAX_CENTS,
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
