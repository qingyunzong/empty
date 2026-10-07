"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const node_assert_1 = __importDefault(require("node:assert"));
const parser_1 = require("../src/parser");
(0, node_test_1.default)("parses variable domains including int64 extremes", () => {
    const p = (0, parser_1.parseProblem)(`var x in [${parser_1.INT64_MIN}, ${parser_1.INT64_MAX}]\nvar y in [-5, 10]`);
    node_assert_1.default.equal(p.domains.get("x").lo, parser_1.INT64_MIN);
    node_assert_1.default.equal(p.domains.get("x").hi, parser_1.INT64_MAX);
    node_assert_1.default.equal(p.domains.get("y").hi, 10n);
});
(0, node_test_1.default)("rejects domains outside int64 or empty", () => {
    node_assert_1.default.throws(() => (0, parser_1.parseProblem)(`var x in [0, ${parser_1.INT64_MAX + 1n}]`), parser_1.ParseError);
    node_assert_1.default.throws(() => (0, parser_1.parseProblem)("var x in [5, 4]"), parser_1.ParseError);
});
(0, node_test_1.default)("parses inequalities and normalizes to lhs OP 0", () => {
    const p = (0, parser_1.parseProblem)("var x in [0, 100]\n2*x + 3 <= 15\nx + 1 >= 2*x - 3");
    const [c1, c2] = p.constraints;
    node_assert_1.default.equal(c1.kind, "ineq");
    if (c1.kind === "ineq") {
        node_assert_1.default.equal(c1.op, "<=");
        node_assert_1.default.equal(c1.expr.coeffs.get("x"), 2n);
        node_assert_1.default.equal(c1.expr.constant, -12n);
    }
    if (c2.kind === "ineq") {
        node_assert_1.default.equal(c2.expr.coeffs.get("x"), -1n);
        node_assert_1.default.equal(c2.expr.constant, 4n);
    }
});
(0, node_test_1.default)("parses both congruence syntaxes", () => {
    const p = (0, parser_1.parseProblem)("var x in [0, 100]\nx % 7 == 3\n2*x + 1 == 5 (mod 12)");
    const [c1, c2] = p.constraints;
    node_assert_1.default.equal(c1.kind, "cong");
    if (c1.kind === "cong") {
        node_assert_1.default.equal(c1.modulus, 7n);
        node_assert_1.default.equal(c1.expr.constant, -3n);
    }
    if (c2.kind === "cong") {
        node_assert_1.default.equal(c2.modulus, 12n);
        node_assert_1.default.equal(c2.expr.coeffs.get("x"), 2n);
        node_assert_1.default.equal(c2.expr.constant, -4n);
    }
});
(0, node_test_1.default)("parses comments, parentheses and unary minus", () => {
    const p = (0, parser_1.parseProblem)("# demo\nvar x in [-10, 10] # domain\n-(x + 3) <= 2*(x - 1)");
    const c = p.constraints[0];
    if (c.kind === "ineq") {
        node_assert_1.default.equal(c.expr.coeffs.get("x"), -3n);
        node_assert_1.default.equal(c.expr.constant, -1n);
    }
    else {
        node_assert_1.default.fail("expected inequality");
    }
});
(0, node_test_1.default)("rejects non-linear terms, unknown variables, bad modulus", () => {
    node_assert_1.default.throws(() => (0, parser_1.parseProblem)("var x in [0, 9]\nx*x <= 3"), parser_1.ParseError);
    node_assert_1.default.throws(() => (0, parser_1.parseProblem)("var x in [0, 9]\ny <= 3"), parser_1.ParseError);
    node_assert_1.default.throws(() => (0, parser_1.parseProblem)("var x in [0, 9]\nx % 0 == 1"), parser_1.ParseError);
    node_assert_1.default.throws(() => (0, parser_1.parseProblem)("var x in [0, 9]\nvar x in [0, 9]"), parser_1.ParseError);
});
