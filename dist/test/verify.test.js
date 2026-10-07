import { test } from "node:test";
import assert from "node:assert";
import { scan, filter, project, join, and, eq, gt, col, lit, isNull, isNotNull, filterPushdownIntoJoin, outerToInnerJoin, projectEliminationIdentity, projectEliminationNested, joinCommutativity, leftRightJoinSwap, verifyEquivalence, optimize, } from "../src/index.js";
// Two-table exhaustive space: columns R.c0,R.c1 / S.c0,S.c1, domain {NULL,0,1},
// all multisets of 0..2 rows per table -> 55 tables/side -> 3025 combinations.
const SPECS = [
    { name: "R", arity: 2 },
    { name: "S", arity: 2 },
];
const ONE = [{ name: "R", arity: 2 }];
const A = col("R.c0"), B = col("R.c1"), C = col("S.c0"), D = col("S.c1");
const key = eq(A, C);
function must(x) {
    assert.ok(x, "expected rule to fire");
    return x;
}
test("EXHAUSTIVE: filter pushdown into inner join (values + duplicates)", () => {
    const original = (t) => filter(and(gt(A, lit(0)), gt(D, lit(0))), join("inner", key, scan(t["R"]), scan(t["S"])));
    const rewritten = (t) => must(filterPushdownIntoJoin(original(t))).plan;
    const r = verifyEquivalence(SPECS, original, rewritten);
    assert.ok(r.ok, JSON.stringify(r.counterexample));
    assert.equal(r.combinationsChecked, 3025);
});
test("EXHAUSTIVE: null-rejecting filter pushed into null-supplying side of left join", () => {
    const original = (t) => filter(gt(D, lit(0)), join("left", key, scan(t["R"]), scan(t["S"])));
    const rewritten = (t) => must(filterPushdownIntoJoin(original(t))).plan;
    const r = verifyEquivalence(SPECS, original, rewritten);
    assert.ok(r.ok, JSON.stringify(r.counterexample));
});
test("EXHAUSTIVE: outer-to-inner join collapse", () => {
    const original = (t) => filter(isNotNull(D), join("left", key, scan(t["R"]), scan(t["S"])));
    const rewritten = (t) => must(outerToInnerJoin(original(t))).plan;
    const r = verifyEquivalence(SPECS, original, rewritten);
    assert.ok(r.ok, JSON.stringify(r.counterexample));
});
test("EXHAUSTIVE: project elimination (identity + nested)", () => {
    const idOrig = (t) => project(["R.c0", "R.c1"], scan(t["R"]));
    const idRew = (t) => must(projectEliminationIdentity(idOrig(t))).plan;
    assert.ok(verifyEquivalence(ONE, idOrig, idRew).ok);
    const nOrig = (t) => project(["R.c0"], project(["R.c0", "R.c1"], scan(t["R"])));
    const nRew = (t) => must(projectEliminationNested(nOrig(t))).plan;
    assert.ok(verifyEquivalence(ONE, nOrig, nRew).ok);
});
test("EXHAUSTIVE: inner join commutativity and left/right mirror swap", () => {
    const cOrig = (t) => join("inner", key, scan(t["R"]), scan(t["S"]));
    const cRew = (t) => must(joinCommutativity(cOrig(t))).plan;
    assert.ok(verifyEquivalence(SPECS, cOrig, cRew).ok);
    const sOrig = (t) => join("left", key, scan(t["R"]), scan(t["S"]));
    const sRew = (t) => must(leftRightJoinSwap(sOrig(t))).plan;
    assert.ok(verifyEquivalence(SPECS, sOrig, sRew).ok);
});
test("NEGATIVE CONTROL: illegal pushdown into null-supplying side is caught by the checker", () => {
    // Pushing `d IS NULL` below a LEFT join is unsound; the exhaustive checker
    // must find a counterexample, proving the verification has teeth.
    const original = (t) => filter(isNull(D), join("left", key, scan(t["R"]), scan(t["S"])));
    const illegal = (t) => join("left", key, scan(t["R"]), filter(isNull(D), scan(t["S"])));
    const r = verifyEquivalence(SPECS, original, illegal);
    assert.ok(!r.ok, "checker must reject the illegal rewrite");
    assert.ok(r.counterexample);
});
test("NEGATIVE CONTROL: outer join commutativity is unsound and caught", () => {
    const original = (t) => join("left", key, scan(t["R"]), scan(t["S"]));
    const illegal = (t) => project(["R.c0", "R.c1", "S.c0", "S.c1"], join("left", key, scan(t["S"]), scan(t["R"])));
    const r = verifyEquivalence(SPECS, original, illegal);
    assert.ok(!r.ok);
});
test("EXHAUSTIVE: full join strengthened to inner by two-sided null-rejecting conjuncts", () => {
    const original = (t) => filter(and(isNotNull(B), gt(D, lit(0))), join("full", key, scan(t["R"]), scan(t["S"])));
    const rewritten = (t) => must(filterPushdownIntoJoin(original(t))).plan;
    const r = verifyEquivalence(SPECS, original, rewritten);
    assert.ok(r.ok, JSON.stringify(r.counterexample));
});
test("EXHAUSTIVE: full optimizer pipeline (certificate chain) preserves values and duplicates", () => {
    const original = (t) => project(["R.c0", "R.c1", "S.c0", "S.c1"], filter(and(gt(A, lit(0)), isNotNull(D)), join("left", key, scan(t["R"]), scan(t["S"]))));
    const rewritten = (t) => optimize(original(t)).plan;
    const r = verifyEquivalence(SPECS, original, rewritten);
    assert.ok(r.ok, JSON.stringify(r.counterexample));
    assert.equal(r.combinationsChecked, 3025);
});
