import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeBase64Url } from "../src/base64";
import {
  CellValue,
  InvalidCursorError,
  StaleCursorError,
  Table,
  Triple,
  compareTriples,
  fullJoin,
  joinAll,
  joinPage,
} from "../src/join";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed: number) {
  const next = mulberry32(seed);
  return {
    int(lo: number, hi: number): number {
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!;
    },
    chance(p: number): boolean {
      return next() < p;
    },
  };
}

const KEY_POOL: readonly CellValue[] = [null, 1, 2, 3, 7, 10, "a", "b", "z"];

function randomTable(rng: ReturnType<typeof makeRng>, size: number): Table {
  const table = new Table();
  for (let i = 0; i < size; i++) {
    table.insert(rng.pick(KEY_POOL));
  }
  return table;
}

function triplesOf(entries: Array<[CellValue, number, number]>): Triple[] {
  return entries
    .filter(([key]) => key !== null)
    .map(([key, leftId, rightId]) => ({ key: key as string | number, leftId, rightId }))
    .sort(compareTriples);
}

describe("inner join with duplicate keys", () => {
  it("produces the cartesian product per key, ordered by key/leftId/rightId", () => {
    const left = new Table([{ key: "x" }, { key: "y" }, { key: "x" }]);
    const right = new Table([{ key: "x" }, { key: "x" }, { key: "y" }]);
    assert.deepEqual(joinAll(left, right), [
      { key: "x", leftId: 1, rightId: 1 },
      { key: "x", leftId: 1, rightId: 2 },
      { key: "x", leftId: 3, rightId: 1 },
      { key: "x", leftId: 3, rightId: 2 },
      { key: "y", leftId: 2, rightId: 3 },
    ]);
  });

  it("orders numeric keys numerically and before string keys", () => {
    const left = new Table([{ key: "b" }, { key: 10 }, { key: 2 }, { key: "a" }]);
    const right = new Table([{ key: "b" }, { key: 10 }, { key: 2 }, { key: "a" }]);
    assert.deepEqual(
      joinAll(left, right).map((t) => t.key),
      [2, 10, "a", "b"],
    );
  });

  it("never matches null keys, not even null with null", () => {
    const left = new Table([{ key: null }, { key: null }, { key: 1 }]);
    const right = new Table([{ key: null }, { key: 1 }]);
    assert.deepEqual(joinAll(left, right), [{ key: 1, leftId: 3, rightId: 2 }]);
  });

  it("returns an empty result when either side is empty", () => {
    const empty = new Table();
    const full = new Table([{ key: 1 }]);
    assert.deepEqual(joinAll(empty, full), []);
    assert.deepEqual(joinAll(full, empty), []);
    assert.deepEqual(joinAll(empty, new Table()), []);
  });
});

describe("cursor pagination", () => {
  it("reconstructs the full join across pages of size 1", () => {
    const left = new Table([{ key: "k" }, { key: "k" }, { key: "j" }]);
    const right = new Table([{ key: "k" }, { key: "k" }]);
    const expected = joinAll(left, right);
    assert.equal(expected.length, 4);

    const collected: Triple[] = [];
    let cursor: string | undefined;
    do {
      const page = joinPage(left, right, { limit: 1, cursor });
      collected.push(...page.rows);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.deepEqual(collected, expected);
  });

  it("returns nextCursor null exactly when the result is exhausted", () => {
    const left = new Table([{ key: 1 }, { key: 1 }]);
    const right = new Table([{ key: 1 }]);
    const first = joinPage(left, right, { limit: 2 });
    assert.equal(first.rows.length, 2);
    assert.equal(first.nextCursor, null);

    const second = joinPage(left, right, { limit: 1 });
    assert.notEqual(second.nextCursor, null);
    const third = joinPage(left, right, { limit: 1, cursor: second.nextCursor! });
    assert.equal(third.rows.length, 1);
    assert.equal(third.nextCursor, null);
  });

  it("rejects a cursor after the left table changed", () => {
    const left = new Table([{ key: 1 }, { key: 1 }, { key: 1 }]);
    const right = new Table([{ key: 1 }]);
    const page = joinPage(left, right, { limit: 1 });
    left.insert(1);
    assert.throws(
      () => joinPage(left, right, { limit: 1, cursor: page.nextCursor! }),
      StaleCursorError,
    );
  });

  it("rejects a cursor after the right table changed", () => {
    const left = new Table([{ key: 1 }]);
    const right = new Table([{ key: 1 }, { key: 1 }, { key: 1 }]);
    const page = joinPage(left, right, { limit: 1 });
    right.delete(2);
    assert.throws(
      () => joinPage(left, right, { limit: 1, cursor: page.nextCursor! }),
      StaleCursorError,
    );
  });

  it("rejects a cursor carried over from different tables", () => {
    const a1 = new Table([{ key: 1 }, { key: 1 }]);
    const b1 = new Table([{ key: 1 }]);
    const a2 = new Table([{ key: 1 }, { key: 1 }]);
    const b2 = new Table([{ key: 1 }]);
    const page = joinPage(a1, b1, { limit: 1 });
    assert.throws(
      () => joinPage(a2, b2, { limit: 1, cursor: page.nextCursor! }),
      StaleCursorError,
    );
  });

  it("rejects malformed cursors and non-positive limits", () => {
    const left = new Table([{ key: 1 }]);
    const right = new Table([{ key: 1 }]);
    assert.throws(() => joinPage(left, right, { limit: 1, cursor: "not-a-cursor" }), InvalidCursorError);
    assert.throws(
      () => joinPage(left, right, { limit: 1, cursor: encodeBase64Url("{}") }),
      InvalidCursorError,
    );
    assert.throws(() => joinPage(left, right, { limit: 0 }), RangeError);
    assert.throws(() => joinPage(left, right, { limit: -3 }), RangeError);
    assert.throws(() => joinPage(left, right, { limit: 1.5 }), RangeError);
  });
});

describe("randomized verification against snapshot reference", () => {
  const SEEDS = [1, 7, 42, 1337, 20261006];

  for (const seed of SEEDS) {
    it(`seed ${seed}: paginated join equals snapshot full join after random mutations`, () => {
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
        } else if (op === 1) {
          table.update(rng.pick(rows).id, rng.pick(KEY_POOL));
        } else {
          table.delete(rng.pick(rows).id);
        }
      }

      // Reference: full join computed once over frozen snapshots.
      const reference = fullJoin(left.snapshot(), right.snapshot());

      // Paginate with a random page size and concatenate every page.
      const pageSize = rng.int(1, Math.max(1, reference.length + 2));
      const collected: Triple[] = [];
      let cursor: string | undefined;
      let pageCount = 0;
      do {
        const page = joinPage(left, right, { limit: pageSize, cursor });
        pageCount++;
        assert.ok(page.rows.length <= pageSize, "page exceeds limit");
        collected.push(...page.rows);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      assert.deepEqual(collected, reference);
      assert.equal(pageCount, Math.max(1, Math.ceil(reference.length / pageSize)));

      // Result must be globally sorted by (key, leftId, rightId).
      const sorted = [...collected].sort(compareTriples);
      assert.deepEqual(collected, sorted);
    });
  }

  it("mutating mid-pagination invalidates the in-flight cursor", () => {
    const rng = makeRng(99);
    for (let round = 0; round < 25; round++) {
      const left = randomTable(rng, rng.int(5, 20));
      const right = randomTable(rng, rng.int(5, 20));
      const first = joinPage(left, right, { limit: 1 });
      if (first.nextCursor === null) continue; // fewer than 2 rows: nothing to resume
      const table = rng.chance(0.5) ? left : right;
      table.insert(rng.pick(KEY_POOL));
      assert.throws(
        () => joinPage(left, right, { limit: 1, cursor: first.nextCursor! }),
        StaleCursorError,
      );
    }
  });

  it("duplicate-heavy tables: cross product size matches reference", () => {
    const rng = makeRng(555);
    const left = new Table();
    const right = new Table();
    const leftIds: number[] = [];
    const rightIds: number[] = [];
    for (let i = 0; i < 12; i++) leftIds.push(left.insert("dup"));
    for (let i = 0; i < 9; i++) rightIds.push(right.insert("dup"));
    // Sprinkle nulls and other keys that must not interfere.
    left.insert(null);
    right.insert(null);
    left.insert("other");

    const reference = fullJoin(left.snapshot(), right.snapshot());
    assert.equal(reference.length, 12 * 9);
    assert.deepEqual(joinAll(left, right, 7), reference);

    // Every triple combines one left id with one right id under key "dup".
    for (const triple of reference) {
      assert.equal(triple.key, "dup");
      assert.ok(leftIds.includes(triple.leftId));
      assert.ok(rightIds.includes(triple.rightId));
    }
    void rng;
  });
});

describe("triple ordering helper", () => {
  it("sorts by key, then leftId, then rightId", () => {
    const unordered = triplesOf([
      ["b", 1, 1],
      [2, 1, 2],
      [2, 1, 1],
      [10, 1, 1],
      ["a", 9, 1],
      [2, 0, 5],
    ]);
    assert.deepEqual(
      unordered.map((t) => [t.key, t.leftId, t.rightId]),
      [
        [2, 0, 5],
        [2, 1, 1],
        [2, 1, 2],
        [10, 1, 1],
        ["a", 9, 1],
        ["b", 1, 1],
      ],
    );
  });
});
