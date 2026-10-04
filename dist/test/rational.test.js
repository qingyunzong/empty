import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.js";
test("normalizes sign and reduces", () => {
    assert.equal(Rational.of(2, 4).toString(), "1/2");
    assert.equal(Rational.of(-2, 4).toString(), "-1/2");
    assert.equal(Rational.of(2, -4).toString(), "-1/2");
    assert.equal(Rational.of(6, 3).toString(), "2");
    assert.equal(Rational.of(0, 7).toString(), "0");
});
test("parses decimals exactly", () => {
    assert.equal(Rational.from("0.1").toString(), "1/10");
    assert.equal(Rational.from("-2.75").toString(), "-11/4");
    assert.equal(Rational.from(0.5).toString(), "1/2");
    assert.equal(Rational.from(42).toString(), "42");
});
test("exact arithmetic", () => {
    const a = Rational.of(1, 3).add(Rational.of(1, 6));
    assert.equal(a.toString(), "1/2");
    const b = Rational.of(1, 10).add(Rational.of(2, 10));
    assert.equal(b.toString(), "3/10"); // 0.1 + 0.2, exactly
    assert.equal(Rational.of(3, 4).mul(Rational.of(8, 9)).toString(), "2/3");
    assert.equal(Rational.of(1, 2).div(Rational.of(3, 4)).toString(), "2/3");
    assert.equal(Rational.of(5, 6).sub(Rational.of(1, 6)).toString(), "2/3");
});
test("rejects zero denominator and division by zero", () => {
    assert.throws(() => Rational.of(1, 0));
    assert.throws(() => Rational.of(1, 2).div(Rational.zero()));
});
