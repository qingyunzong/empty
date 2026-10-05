import assert from "node:assert/strict";
import test from "node:test";
import { runQuery } from "../src/engine.js";
import { QueryError } from "../src/types.js";
const tables = {
    users: {
        rows: [
            { id: 1, name: "ada" },
            { id: 2, name: "bo" },
            { id: 3, name: "cy" },
            { id: null, name: "noname" },
        ],
    },
    orders: {
        rows: [
            { id: 10, uid: 1, amt: 30 },
            { id: 11, uid: 1, amt: 20 },
            { id: 12, uid: 2, amt: 5 },
            { id: 13, uid: null, amt: 9 },
            { id: 14, uid: 99, amt: 1 },
        ],
    },
};
test("inner join with projection and filter", () => {
    const rows = runQuery({
        from: { table: "users", as: "u" },
        joins: [
            {
                table: "orders",
                as: "o",
                on: { op: "eq", args: [{ col: "u.id" }, { col: "o.uid" }] },
            },
        ],
        where: { op: "gt", args: [{ col: "o.amt" }, { lit: 10 }] },
        select: [
            { col: "u.name", as: "name" },
            { col: "o.amt", as: "amt" },
        ],
    }, tables);
    assert.deepEqual(rows, [
        { name: "ada", amt: 20 },
        { name: "ada", amt: 30 },
    ]);
});
test("NULL join keys never match", () => {
    const rows = runQuery({
        from: { table: "users", as: "u" },
        joins: [
            {
                table: "orders",
                as: "o",
                on: { op: "eq", args: [{ col: "u.id" }, { col: "o.uid" }] },
            },
        ],
        select: [{ agg: { fn: "count", arg: "*" }, as: "n" }],
    }, tables);
    // (null,...) user and (uid null / uid 99) orders never match.
    assert.deepEqual(rows, [{ n: 3 }]);
});
test("grouped join aggregation", () => {
    const rows = runQuery({
        from: { table: "users", as: "u" },
        joins: [
            {
                table: "orders",
                as: "o",
                on: { op: "eq", args: [{ col: "u.id" }, { col: "o.uid" }] },
            },
        ],
        groupBy: ["u.name"],
        select: [
            { col: "u.name", as: "name" },
            { agg: { fn: "count", arg: "o.amt" }, as: "n" },
            { agg: { fn: "sum", arg: "o.amt" }, as: "total" },
        ],
    }, tables);
    assert.deepEqual(rows, [
        { name: "ada", n: 2, total: 50 },
        { name: "bo", n: 1, total: 5 },
    ]);
});
test("non-equi join condition falls back correctly", () => {
    const rows = runQuery({
        from: { table: "users", as: "u" },
        joins: [
            {
                table: "orders",
                as: "o",
                on: { op: "lt", args: [{ col: "o.amt" }, { col: "u.id" }] },
            },
        ],
        select: [
            { col: "u.id", as: "id" },
            { col: "o.id", as: "oid" },
        ],
    }, tables);
    assert.deepEqual(rows, [
        { id: 2, oid: 14 },
        { id: 3, oid: 14 },
    ]);
});
test("ambiguous and unknown columns are rejected", () => {
    assert.throws(() => runQuery({
        from: { table: "users", as: "u" },
        joins: [
            {
                table: "orders",
                as: "o",
                on: { op: "eq", args: [{ col: "u.id" }, { col: "o.uid" }] },
            },
        ],
        select: [{ col: "id" }],
    }, tables), QueryError);
    assert.throws(() => runQuery({ from: { table: "users" }, select: [{ col: "nope" }] }, tables), QueryError);
});
