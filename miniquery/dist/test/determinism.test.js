import assert from "node:assert/strict";
import test from "node:test";
import { runQuery } from "../src/engine.js";
function shuffled(arr, seed) {
    const a = [...arr];
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
const query = {
    from: { table: "users", as: "u" },
    joins: [
        {
            table: "orders",
            as: "o",
            on: { op: "eq", args: [{ col: "u.id" }, { col: "o.uid" }] },
        },
    ],
    where: {
        op: "or",
        args: [
            { op: "ge", args: [{ col: "o.amt" }, { lit: 5 }] },
            { op: "isNull", arg: { col: "o.amt" } },
        ],
    },
    groupBy: ["u.name"],
    select: [
        { col: "u.name", as: "name" },
        { agg: { fn: "count", arg: "o.amt" }, as: "n" },
        { agg: { fn: "sum", arg: "o.amt" }, as: "total" },
        { agg: { fn: "avg", arg: "o.amt" }, as: "avg" },
    ],
};
const users = [
    { id: 1, name: "ada" },
    { id: 2, name: "bo" },
    { id: 3, name: "cy" },
    { id: 4, name: "cy" },
];
const orders = [
    { id: 10, uid: 1, amt: 30 },
    { id: 11, uid: 1, amt: null },
    { id: 12, uid: 2, amt: 5 },
    { id: 13, uid: 3, amt: 7 },
    { id: 14, uid: 4, amt: 9 },
    { id: 15, uid: 3, amt: 1 },
];
test("output order is deterministic regardless of input order", () => {
    const expected = runQuery(query, {
        users: { rows: users },
        orders: { rows: orders },
    });
    for (let seed = 1; seed <= 20; seed++) {
        const tables = {
            users: { rows: shuffled(users, seed) },
            orders: { rows: shuffled(orders, seed * 7 + 1) },
        };
        assert.deepEqual(runQuery(query, tables), expected);
    }
    // Spot-check the actual ordering: NULL-free strings sort by (name).
    assert.deepEqual(expected.map((r) => r["name"]), ["ada", "bo", "cy"]);
});
