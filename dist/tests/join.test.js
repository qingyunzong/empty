"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const base64_1 = require("../src/base64");
const join_1 = require("../src/join");
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function makeRng(seed) {
    const next = mulberry32(seed);
    return {
        int(lo, hi) {
            return lo + Math.floor(next() * (hi - lo + 1));
        },
        pick(items) {
            return items[Math.floor(next() * items.length)];
        },
        chance(p) {
            return next() < p;
        },
    };
}
const KEY_POOL = [null, 1, 2, 3, 7, 10, "a", "b", "z"];
function randomTable(rng, size) {
    const table = new join_1.Table();
    for (let i = 0; i < size; i++) {
        table.insert(rng.pick(KEY_POOL));
    }
    return table;
}
function triplesOf(entries) {
    return entries
        .filter(([key]) => key !== null)
        .map(([key, leftId, rightId]) => ({ key: key, leftId, rightId }))
        .sort(join_1.compareTriples);
}
(0, node_test_1.describe)("inner join with duplicate keys", () => {
    (0, node_test_1.it)("produces the cartesian product per key, ordered by key/leftId/rightId", () => {
        const left = new join_1.Table([{ key: "x" }, { key: "y" }, { key: "x" }]);
        const right = new join_1.Table([{ key: "x" }, { key: "x" }, { key: "y" }]);
        strict_1.default.deepEqual((0, join_1.joinAll)(left, right), [
            { key: "x", leftId: 1, rightId: 1 },
            { key: "x", leftId: 1, rightId: 2 },
            { key: "x", leftId: 3, rightId: 1 },
            { key: "x", leftId: 3, rightId: 2 },
            { key: "y", leftId: 2, rightId: 3 },
        ]);
    });
    (0, node_test_1.it)("orders numeric keys numerically and before string keys", () => {
        const left = new join_1.Table([{ key: "b" }, { key: 10 }, { key: 2 }, { key: "a" }]);
        const right = new join_1.Table([{ key: "b" }, { key: 10 }, { key: 2 }, { key: "a" }]);
        strict_1.default.deepEqual((0, join_1.joinAll)(left, right).map((t) => t.key), [2, 10, "a", "b"]);
    });
    (0, node_test_1.it)("never matches null keys, not even null with null", () => {
        const left = new join_1.Table([{ key: null }, { key: null }, { key: 1 }]);
        const right = new join_1.Table([{ key: null }, { key: 1 }]);
        strict_1.default.deepEqual((0, join_1.joinAll)(left, right), [{ key: 1, leftId: 3, rightId: 2 }]);
    });
    (0, node_test_1.it)("returns an empty result when either side is empty", () => {
        const empty = new join_1.Table();
        const full = new join_1.Table([{ key: 1 }]);
        strict_1.default.deepEqual((0, join_1.joinAll)(empty, full), []);
        strict_1.default.deepEqual((0, join_1.joinAll)(full, empty), []);
        strict_1.default.deepEqual((0, join_1.joinAll)(empty, new join_1.Table()), []);
    });
});
(0, node_test_1.describe)("cursor pagination", () => {
    (0, node_test_1.it)("reconstructs the full join across pages of size 1", () => {
        const left = new join_1.Table([{ key: "k" }, { key: "k" }, { key: "j" }]);
        const right = new join_1.Table([{ key: "k" }, { key: "k" }]);
        const expected = (0, join_1.joinAll)(left, right);
        strict_1.default.equal(expected.length, 4);
        const collected = [];
        let cursor;
        do {
            const page = (0, join_1.joinPage)(left, right, { limit: 1, cursor });
            collected.push(...page.rows);
            cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        strict_1.default.deepEqual(collected, expected);
    });
    (0, node_test_1.it)("returns nextCursor null exactly when the result is exhausted", () => {
        const left = new join_1.Table([{ key: 1 }, { key: 1 }]);
        const right = new join_1.Table([{ key: 1 }]);
        const first = (0, join_1.joinPage)(left, right, { limit: 2 });
        strict_1.default.equal(first.rows.length, 2);
        strict_1.default.equal(first.nextCursor, null);
        const second = (0, join_1.joinPage)(left, right, { limit: 1 });
        strict_1.default.notEqual(second.nextCursor, null);
        const third = (0, join_1.joinPage)(left, right, { limit: 1, cursor: second.nextCursor });
        strict_1.default.equal(third.rows.length, 1);
        strict_1.default.equal(third.nextCursor, null);
    });
    (0, node_test_1.it)("rejects a cursor after the left table changed", () => {
        const left = new join_1.Table([{ key: 1 }, { key: 1 }, { key: 1 }]);
        const right = new join_1.Table([{ key: 1 }]);
        const page = (0, join_1.joinPage)(left, right, { limit: 1 });
        left.insert(1);
        strict_1.default.throws(() => (0, join_1.joinPage)(left, right, { limit: 1, cursor: page.nextCursor }), join_1.StaleCursorError);
    });
    (0, node_test_1.it)("rejects a cursor after the right table changed", () => {
        const left = new join_1.Table([{ key: 1 }]);
        const right = new join_1.Table([{ key: 1 }, { key: 1 }, { key: 1 }]);
        const page = (0, join_1.joinPage)(left, right, { limit: 1 });
        right.delete(2);
        strict_1.default.throws(() => (0, join_1.joinPage)(left, right, { limit: 1, cursor: page.nextCursor }), join_1.StaleCursorError);
    });
    (0, node_test_1.it)("rejects a cursor carried over from different tables", () => {
        const a1 = new join_1.Table([{ key: 1 }, { key: 1 }]);
        const b1 = new join_1.Table([{ key: 1 }]);
        const a2 = new join_1.Table([{ key: 1 }, { key: 1 }]);
        const b2 = new join_1.Table([{ key: 1 }]);
        const page = (0, join_1.joinPage)(a1, b1, { limit: 1 });
        strict_1.default.throws(() => (0, join_1.joinPage)(a2, b2, { limit: 1, cursor: page.nextCursor }), join_1.StaleCursorError);
    });
    (0, node_test_1.it)("rejects malformed cursors and non-positive limits", () => {
        const left = new join_1.Table([{ key: 1 }]);
        const right = new join_1.Table([{ key: 1 }]);
        strict_1.default.throws(() => (0, join_1.joinPage)(left, right, { limit: 1, cursor: "not-a-cursor" }), join_1.InvalidCursorError);
        strict_1.default.throws(() => (0, join_1.joinPage)(left, right, { limit: 1, cursor: (0, base64_1.encodeBase64Url)("{}") }), join_1.InvalidCursorError);
        strict_1.default.throws(() => (0, join_1.joinPage)(left, right, { limit: 0 }), RangeError);
        strict_1.default.throws(() => (0, join_1.joinPage)(left, right, { limit: -3 }), RangeError);
        strict_1.default.throws(() => (0, join_1.joinPage)(left, right, { limit: 1.5 }), RangeError);
    });
});
(0, node_test_1.describe)("randomized verification against snapshot reference", () => {
    const SEEDS = [1, 7, 42, 1337, 20261006];
    for (const seed of SEEDS) {
        (0, node_test_1.it)(`seed ${seed}: paginated join equals snapshot full join after random mutations`, () => {
            const rng = makeRng(seed);
            const left = randomTable(rng, rng.int(0, 30));
            const right = randomTable(rng, rng.int(0, 30));
            // Random mutations: inserts, updates, deletes on both tables.
            const mutations = rng.int(0, 40);
            for (let i = 0; i < mutations; i++) {
                const table = rng.chance(0.5) ? left : right;
                const rows = table.snapshot();
                const op = rng.int(0, 2);
                if (op === 0 || rows.length === 0) {
                    table.insert(rng.pick(KEY_POOL));
                }
                else if (op === 1) {
                    table.update(rng.pick(rows).id, rng.pick(KEY_POOL));
                }
                else {
                    table.delete(rng.pick(rows).id);
                }
            }
            // Reference: full join computed once over frozen snapshots.
            const reference = (0, join_1.fullJoin)(left.snapshot(), right.snapshot());
            // Paginate with a random page size and concatenate every page.
            const pageSize = rng.int(1, Math.max(1, reference.length + 2));
            const collected = [];
            let cursor;
            let pageCount = 0;
            do {
                const page = (0, join_1.joinPage)(left, right, { limit: pageSize, cursor });
                pageCount++;
                strict_1.default.ok(page.rows.length <= pageSize, "page exceeds limit");
                collected.push(...page.rows);
                cursor = page.nextCursor ?? undefined;
            } while (cursor !== undefined);
            strict_1.default.deepEqual(collected, reference);
            strict_1.default.equal(pageCount, Math.max(1, Math.ceil(reference.length / pageSize)));
            // Result must be globally sorted by (key, leftId, rightId).
            const sorted = [...collected].sort(join_1.compareTriples);
            strict_1.default.deepEqual(collected, sorted);
        });
    }
    (0, node_test_1.it)("mutating mid-pagination invalidates the in-flight cursor", () => {
        const rng = makeRng(99);
        for (let round = 0; round < 25; round++) {
            const left = randomTable(rng, rng.int(5, 20));
            const right = randomTable(rng, rng.int(5, 20));
            const first = (0, join_1.joinPage)(left, right, { limit: 1 });
            if (first.nextCursor === null)
                continue; // fewer than 2 rows: nothing to resume
            const table = rng.chance(0.5) ? left : right;
            table.insert(rng.pick(KEY_POOL));
            strict_1.default.throws(() => (0, join_1.joinPage)(left, right, { limit: 1, cursor: first.nextCursor }), join_1.StaleCursorError);
        }
    });
    (0, node_test_1.it)("duplicate-heavy tables: cross product size matches reference", () => {
        const rng = makeRng(555);
        const left = new join_1.Table();
        const right = new join_1.Table();
        const leftIds = [];
        const rightIds = [];
        for (let i = 0; i < 12; i++)
            leftIds.push(left.insert("dup"));
        for (let i = 0; i < 9; i++)
            rightIds.push(right.insert("dup"));
        // Sprinkle nulls and other keys that must not interfere.
        left.insert(null);
        right.insert(null);
        left.insert("other");
        const reference = (0, join_1.fullJoin)(left.snapshot(), right.snapshot());
        strict_1.default.equal(reference.length, 12 * 9);
        strict_1.default.deepEqual((0, join_1.joinAll)(left, right, 7), reference);
        // Every triple combines one left id with one right id under key "dup".
        for (const triple of reference) {
            strict_1.default.equal(triple.key, "dup");
            strict_1.default.ok(leftIds.includes(triple.leftId));
            strict_1.default.ok(rightIds.includes(triple.rightId));
        }
        void rng;
    });
});
(0, node_test_1.describe)("triple ordering helper", () => {
    (0, node_test_1.it)("sorts by key, then leftId, then rightId", () => {
        const unordered = triplesOf([
            ["b", 1, 1],
            [2, 1, 2],
            [2, 1, 1],
            [10, 1, 1],
            ["a", 9, 1],
            [2, 0, 5],
        ]);
        strict_1.default.deepEqual(unordered.map((t) => [t.key, t.leftId, t.rightId]), [
            [2, 0, 5],
            [2, 1, 1],
            [2, 1, 2],
            [10, 1, 1],
            ["a", 9, 1],
            ["b", 1, 1],
        ]);
    });
});
