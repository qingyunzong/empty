"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const fraction_1 = require("../src/fraction");
(0, node_test_1.test)("normalizes sign and gcd", () => {
    const f = fraction_1.Fraction.of(6, -8);
    strict_1.default.equal(f.num, -3n);
    strict_1.default.equal(f.den, 4n);
    strict_1.default.equal(fraction_1.Fraction.of(0, 5).toString(), "0");
});
(0, node_test_1.test)("parses fractions, decimals, integers", () => {
    strict_1.default.ok(fraction_1.Fraction.parse("3/4").eq(fraction_1.Fraction.of(3, 4)));
    strict_1.default.ok(fraction_1.Fraction.parse("1.5").eq(fraction_1.Fraction.of(3, 2)));
    strict_1.default.ok(fraction_1.Fraction.parse("-0.25").eq(fraction_1.Fraction.of(-1, 4)));
    strict_1.default.ok(fraction_1.Fraction.parse("120").eq(fraction_1.Fraction.of(120)));
});
(0, node_test_1.test)("arithmetic is exact", () => {
    const a = fraction_1.Fraction.of(1, 3);
    const b = fraction_1.Fraction.of(1, 6);
    strict_1.default.ok(a.add(b).eq(fraction_1.Fraction.of(1, 2)));
    strict_1.default.ok(a.sub(b).eq(fraction_1.Fraction.of(1, 6)));
    strict_1.default.ok(a.mul(b).eq(fraction_1.Fraction.of(1, 18)));
    strict_1.default.ok(a.div(b).eq(fraction_1.Fraction.of(2)));
    // 1/3 + 1/3 + 1/3 === 1 exactly (float would give 0.9999999999999999)
    strict_1.default.ok(a.add(a).add(a).eq(fraction_1.Fraction.of(1)));
});
(0, node_test_1.test)("comparison", () => {
    strict_1.default.ok(fraction_1.Fraction.of(1, 3).gt(fraction_1.Fraction.of(1, 4)));
    strict_1.default.ok(fraction_1.Fraction.of(2, 4).eq(fraction_1.Fraction.of(1, 2)));
    strict_1.default.equal(fraction_1.Fraction.of(-1).cmp(fraction_1.Fraction.of(1)), -1);
});
(0, node_test_1.test)("rejects zero denominator and division by zero", () => {
    strict_1.default.throws(() => fraction_1.Fraction.of(1, 0));
    strict_1.default.throws(() => fraction_1.Fraction.of(1).div(fraction_1.Fraction.ZERO));
});
