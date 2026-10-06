import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.js";
test("normalizes sign and reduces by gcd", () => {
    const a = Rational.of(6n, -8n);
    assert.equal(a.num, -3n);
    assert.equal(a.den, 4n);
    assert.equal(Rational.of(0n, 5n).den, 1n);
    assert.throws(() => Rational.of(1n, 0n));
});
test("exact arithmetic", () => {
    assert.equal(Rational.of(1n, 3n).add(Rational.of(1n, 6n)).toString(), "1/2");
    assert.equal(Rational.of(2n, 3n).mul(Rational.of(9n, 4n)).toString(), "3/2");
    assert.equal(Rational.of(1n, 2n).sub(Rational.of(3n, 4n)).toString(), "-1/4");
    assert.equal(Rational.of(1n, 3n).cmp(Rational.of(2n, 7n)), 1);
    assert.equal(Rational.of(2n, 6n).cmp(Rational.of(1n, 3n)), 0);
});
test("roundHalfEven rounds halves to the even neighbor", () => {
    const cases = [
        ["1/2", 0n],
        ["3/2", 2n],
        ["5/2", 2n],
        ["7/2", 4n],
        ["-1/2", 0n],
        ["-3/2", -2n],
        ["-5/2", -2n],
        ["1/3", 0n],
        ["2/3", 1n],
        ["7/3", 2n],
        ["-2/3", -1n],
        ["4", 4n],
    ];
    for (const [src, want] of cases) {
        const [n, d] = src.split("/");
        assert.equal(Rational.of(BigInt(n), BigInt(d ?? "1")).roundHalfEven(), want, src);
    }
});
