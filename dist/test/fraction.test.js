import { test } from "node:test";
import assert from "node:assert/strict";
import { Fraction } from "../src/index.js";
test("normalizes sign and reduces to lowest terms", () => {
    assert.equal(Fraction.of(2, 4).toString(), "1/2");
    assert.equal(Fraction.of(3, -6).toString(), "-1/2");
    assert.equal(Fraction.of(-3, -6).toString(), "1/2");
    assert.equal(Fraction.of(5, 1).toString(), "5");
    assert.equal(Fraction.of(0, 7).toString(), "0");
});
test("arithmetic is exact", () => {
    const third = Fraction.of(1, 3);
    const sixth = Fraction.of(1, 6);
    assert.ok(third.add(sixth).equals(Fraction.of(1, 2)));
    assert.ok(third.sub(sixth).equals(sixth));
    assert.ok(third.mul(sixth).equals(Fraction.of(1, 18)));
    assert.ok(third.div(sixth).equals(Fraction.of(2)));
    // 1/3 + 1/3 + 1/3 is exactly 1, no floating point drift.
    assert.ok(third.add(third).add(third).equals(Fraction.ONE));
});
test("comparison and equality", () => {
    assert.equal(Fraction.of(1, 3).cmp(Fraction.of(2, 7)), 1);
    assert.equal(Fraction.of(2, 6).cmp(Fraction.of(1, 3)), 0);
    assert.ok(Fraction.of(-1, 2).equals(Fraction.of(1, -2)));
});
test("rejects non-integer and zero-denominator input", () => {
    assert.throws(() => Fraction.of(1.5), TypeError);
    assert.throws(() => Fraction.of(1, 0), RangeError);
});
