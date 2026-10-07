"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const node_assert_1 = __importDefault(require("node:assert"));
const bigint_math_1 = require("../src/bigint-math");
(0, node_test_1.default)("floorDiv/ceilDiv handle all sign combinations exactly", () => {
    node_assert_1.default.equal((0, bigint_math_1.floorDiv)(7n, 2n), 3n);
    node_assert_1.default.equal((0, bigint_math_1.floorDiv)(-7n, 2n), -4n);
    node_assert_1.default.equal((0, bigint_math_1.floorDiv)(7n, -2n), -4n);
    node_assert_1.default.equal((0, bigint_math_1.floorDiv)(-7n, -2n), 3n);
    node_assert_1.default.equal((0, bigint_math_1.floorDiv)(6n, 3n), 2n);
    node_assert_1.default.equal((0, bigint_math_1.floorDiv)(-6n, 3n), -2n);
    node_assert_1.default.equal((0, bigint_math_1.ceilDiv)(7n, 2n), 4n);
    node_assert_1.default.equal((0, bigint_math_1.ceilDiv)(-7n, 2n), -3n);
    node_assert_1.default.equal((0, bigint_math_1.ceilDiv)(7n, -2n), -3n);
    node_assert_1.default.equal((0, bigint_math_1.ceilDiv)(-7n, -2n), 4n);
    node_assert_1.default.equal((0, bigint_math_1.ceilDiv)(6n, 3n), 2n);
    node_assert_1.default.equal((0, bigint_math_1.ceilDiv)(-6n, 3n), -2n);
});
(0, node_test_1.default)("floorDiv/ceilDiv on huge values beyond double precision", () => {
    const a = 9223372036854775796n; // 2^63 - 12, not representable as double
    node_assert_1.default.equal((0, bigint_math_1.floorDiv)(a, 8n), 1152921504606846974n);
    node_assert_1.default.equal((0, bigint_math_1.ceilDiv)(a, 8n), 1152921504606846975n);
    node_assert_1.default.equal((0, bigint_math_1.floorDiv)(-a, 8n), -1152921504606846975n);
});
(0, node_test_1.default)("gcd and mod", () => {
    node_assert_1.default.equal((0, bigint_math_1.gcd)(12n, 18n), 6n);
    node_assert_1.default.equal((0, bigint_math_1.gcd)(-12n, 18n), 6n);
    node_assert_1.default.equal((0, bigint_math_1.gcd)(0n, 5n), 5n);
    node_assert_1.default.equal((0, bigint_math_1.mod)(-3n, 7n), 4n);
    node_assert_1.default.equal((0, bigint_math_1.mod)(10n, 5n), 0n);
});
(0, node_test_1.default)("modInverse", () => {
    node_assert_1.default.equal((0, bigint_math_1.modInverse)(3n, 7n), 5n);
    node_assert_1.default.equal((0, bigint_math_1.modInverse)(2n, 4n), null);
    const big = (0, bigint_math_1.modInverse)(1000000007n, 1000000009n);
    node_assert_1.default.ok(big !== null);
    node_assert_1.default.equal((1000000007n * big) % 1000000009n, 1n);
});
(0, node_test_1.default)("crtMerge consistent and conflicting", () => {
    const merged = (0, bigint_math_1.crtMerge)({ residue: 1n, modulus: 4n }, { residue: 3n, modulus: 6n });
    node_assert_1.default.ok("congruence" in merged);
    if ("congruence" in merged) {
        node_assert_1.default.equal(merged.congruence.residue, 9n);
        node_assert_1.default.equal(merged.congruence.modulus, 12n);
    }
    const conflict = (0, bigint_math_1.crtMerge)({ residue: 0n, modulus: 4n }, { residue: 3n, modulus: 6n });
    node_assert_1.default.ok("conflict" in conflict);
    if ("conflict" in conflict)
        node_assert_1.default.equal(conflict.conflict.gcd, 2n);
});
