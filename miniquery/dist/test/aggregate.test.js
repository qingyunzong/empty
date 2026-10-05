import assert from "node:assert/strict";
import test from "node:test";
import { runQuery } from "../src/engine.js";
import { parseJsonExact } from "../src/values.js";
const tables = {
    sales: {
        rows: [
            { region: "cn", amount: 10, qty: 1 },
            { region: "cn", amount: null, qty: 2 },
            { region: "us", amount: 5, qty: null },
            { region: null, amount: 7, qty: 3 },
            { region: null, amount: null, qty: null },
        ],
    },
};
test("COUNT(*) counts rows, COUNT(col) ignores NULL", () => {
    const rows = runQuery({
        from: { table: "sales" },
        select: [
            { agg: { fn: "count", arg: "*" }, as: "rows" },
            { agg: { fn: "count", arg: "amount" }, as: "amounts" },
            { agg: { fn: "count", arg: "qty" }, as: "qtys" },
        ],
    }, tables);
    assert.deepEqual(rows, [{ rows: 5, amounts: 3, qtys: 3 }]);
});
test("SUM/MIN/MAX ignore NULL; all-NULL yields NULL", () => {
    const q = (groupBy) => ({
        from: { table: "sales" },
        ...(groupBy ? { groupBy } : {}),
        select: [
            ...(groupBy ? groupBy.map((col) => ({ col })) : []),
            { agg: { fn: "sum", arg: "amount" }, as: "s" },
            { agg: { fn: "min", arg: "amount" }, as: "mi" },
            { agg: { fn: "max", arg: "amount" }, as: "ma" },
        ],
    });
    assert.deepEqual(runQuery(q(), tables), [{ s: 22, mi: 5, ma: 10 }]);
    // GROUP BY with NULL keys: NULLs form one group; deterministic order (NULL first).
    assert.deepEqual(runQuery(q(["region"]), tables), [
        { region: null, s: 7, mi: 7, ma: 7 },
        { region: "cn", s: 10, mi: 10, ma: 10 },
        { region: "us", s: 5, mi: 5, ma: 5 },
    ]);
});
test("AVG ignores NULL", () => {
    const rows = runQuery({ from: { table: "sales" }, select: [{ agg: { fn: "avg", arg: "amount" }, as: "a" }] }, tables);
    assert.deepEqual(rows, [{ a: 22 / 3 }]);
});
test("aggregates over empty input", () => {
    const empty = { t: { columns: ["x"], rows: [] } };
    const aggOnly = runQuery({
        from: { table: "t" },
        select: [
            { agg: { fn: "count", arg: "*" }, as: "n" },
            { agg: { fn: "sum", arg: "x" }, as: "s" },
        ],
    }, empty);
    assert.deepEqual(aggOnly, [{ n: 0, s: null }]);
    const grouped = runQuery({
        from: { table: "t" },
        groupBy: ["x"],
        select: [{ col: "x" }, { agg: { fn: "count", arg: "*" }, as: "n" }],
    }, empty);
    assert.deepEqual(grouped, []);
});
test("integer arithmetic is exact beyond 2^53", () => {
    const big = parseJsonExact(`{"t":{"rows":[{"x":9007199254740993},{"x":9007199254740993}]}}`);
    const rows = runQuery({ from: { table: "t" }, select: [{ agg: { fn: "sum", arg: "x" }, as: "s" }] }, { t: big.t });
    // 18014398509481986 exceeds 2^53 and is serialized as an exact string.
    assert.deepEqual(rows, [{ s: "18014398509481986" }]);
    const grouped = runQuery({
        from: { table: "t" },
        groupBy: ["x"],
        select: [{ col: "x" }, { agg: { fn: "count", arg: "*" }, as: "n" }],
    }, { t: big.t });
    assert.deepEqual(grouped, [{ x: "9007199254740993", n: 2 }]);
});
