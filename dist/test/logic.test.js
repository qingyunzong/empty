import { test } from "node:test";
import assert from "node:assert";
import { T, F, U, triAnd, triOr, triNot, sqlEq, evalPred, and, or, not, eq, lt, gt, col, lit, isNull, isNotNull, } from "../src/index.js";
test("3VL truth tables", () => {
    // AND
    assert.equal(triAnd(T, T), T);
    assert.equal(triAnd(T, F), F);
    assert.equal(triAnd(T, U), U);
    assert.equal(triAnd(F, U), F);
    assert.equal(triAnd(U, U), U);
    // OR
    assert.equal(triOr(T, U), T);
    assert.equal(triOr(F, U), U);
    assert.equal(triOr(F, F), F);
    // NOT
    assert.equal(triNot(T), F);
    assert.equal(triNot(F), T);
    assert.equal(triNot(U), U);
});
test("NULL comparisons are UNKNOWN, never TRUE", () => {
    assert.equal(sqlEq(null, null), U);
    assert.equal(sqlEq(null, 1), U);
    assert.equal(evalPred(eq(col("a"), col("b")), { a: null, b: null }), U);
    assert.equal(evalPred(lt(col("a"), lit(5)), { a: null }), U);
    assert.equal(evalPred(eq(lit(null), lit(null)), {}), U);
});
test("IS NULL / IS NOT NULL are the only NULL-true predicates", () => {
    assert.equal(evalPred(isNull(col("a")), { a: null }), T);
    assert.equal(evalPred(isNotNull(col("a")), { a: null }), F);
    assert.equal(evalPred(isNull(col("a")), { a: 1 }), F);
});
test("compound predicates under 3VL", () => {
    const row = { a: null, b: 3 };
    // (a = 1) OR (b = 3) -> UNKNOWN OR TRUE -> TRUE
    assert.equal(evalPred(or(eq(col("a"), lit(1)), eq(col("b"), lit(3))), row), T);
    // (a = 1) AND (b = 3) -> UNKNOWN AND TRUE -> UNKNOWN
    assert.equal(evalPred(and(eq(col("a"), lit(1)), eq(col("b"), lit(3))), row), U);
    // NOT (a > 1) -> NOT UNKNOWN -> UNKNOWN
    assert.equal(evalPred(not(gt(col("a"), lit(1))), row), U);
});
