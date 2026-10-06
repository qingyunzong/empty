import assert from "node:assert/strict";
import test from "node:test";

import {
  Cursor,
  JoinTriple,
  StaleCursorError,
  Table,
  fullJoin,
  joinQuery,
} from "../src/join.js";

function collectAll(left: Table, right: Table, pageSize: number): JoinTriple[] {
  const out: JoinTriple[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = joinQuery(left, right, { limit: pageSize, ...(cursor ? { cursor } : {}) });
    out.push(...page.rows);
    if (page.cursor === null) return out;
    assert.ok(page.rows.length > 0, "pagination must make progress");
    cursor = page.cursor ?? undefined;
  }
}

test("duplicate keys produce the full cross product, sorted by (key, leftId, rightId)", () => {
  const left = new Table();
  const right = new Table();
  left.insert({ id: 2, key: "a" });
  left.insert({ id: 1, key: "a" });
  left.insert({ id: 3, key: "b" });
  right.insert({ id: 20, key: "a" });
  right.insert({ id: 10, key: "a" });
  right.insert({ id: 30, key: "b" });

  assert.deepEqual(joinQuery(left, right).rows, [
    { key: "a", leftId: 1, rightId: 10 },
    { key: "a", leftId: 1, rightId: 20 },
    { key: "a", leftId: 2, rightId: 10 },
    { key: "a", leftId: 2, rightId: 20 },
    { key: "b", leftId: 3, rightId: 30 },
  ]);
});

test("null keys never match, not even null = null", () => {
  const left = new Table();
  const right = new Table();
  left.insert({ id: 1, key: null });
  left.insert({ id: 2, key: 7 });
  right.insert({ id: 10, key: null });
  right.insert({ id: 11, key: 7 });

  assert.deepEqual(joinQuery(left, right).rows, [{ key: 7, leftId: 2, rightId: 11 }]);
});

test("keys use a total order: numbers before strings, each by value", () => {
  const left = new Table();
  const right = new Table();
  left.insert({ id: 1, key: "b" });
  left.insert({ id: 2, key: 10 });
  left.insert({ id: 3, key: 2 });
  left.insert({ id: 4, key: "a" });
  right.insert({ id: 1, key: "b" });
  right.insert({ id: 2, key: 10 });
  right.insert({ id: 3, key: 2 });
  right.insert({ id: 4, key: "a" });

  assert.deepEqual(
    joinQuery(left, right).rows.map((r) => r.key),
    [2, 10, "a", "b"],
  );
});

test("pagination concatenates to the full join and resumes strictly after the cursor", () => {
  const left = new Table();
  const right = new Table();
  for (let i = 1; i <= 5; i += 1) left.insert({ id: i, key: i % 2 });
  for (let i = 1; i <= 4; i += 1) right.insert({ id: i, key: i % 2 });

  const reference = fullJoin(left.snapshot(), right.snapshot());
  assert.equal(reference.length, 10); // key 1: 3x2, key 0: 2x2

  const seen = new Set<string>();
  let cursor: Cursor | undefined;
  const pages: JoinTriple[][] = [];
  for (;;) {
    const page = joinQuery(left, right, { limit: 5, ...(cursor ? { cursor } : {}) });
    pages.push(page.rows);
    for (const row of page.rows) {
      const tag = `${String(row.key)}|${row.leftId}|${row.rightId}`;
      assert.ok(!seen.has(tag), `duplicate row across pages: ${tag}`);
      seen.add(tag);
    }
    if (page.cursor === null) break;
    cursor = page.cursor ?? undefined;
  }

  assert.equal(pages.length, 2); // 5 + 5
  assert.deepEqual(pages.flat(), reference);
});

test("stale cursor is rejected after any mutation of either table", () => {
  const left = new Table();
  const right = new Table();
  left.insert({ id: 1, key: "x" });
  right.insert({ id: 1, key: "x" });
  right.insert({ id: 2, key: "x" });

  const first = joinQuery(left, right, { limit: 1 });
  assert.equal(first.rows.length, 1);
  const cursor = first.cursor;
  assert.ok(cursor !== null);

  // Same cursor, unchanged tables: replaying the page is allowed.
  assert.deepEqual(joinQuery(left, right, { limit: 1, cursor }).rows, [
    { key: "x", leftId: 1, rightId: 2 },
  ]);

  // Mutating the right table invalidates the cursor.
  right.insert({ id: 3, key: "x" });
  assert.throws(() => joinQuery(left, right, { limit: 1, cursor }), StaleCursorError);

  // So does mutating the left table.
  const cursor2 = joinQuery(left, right, { limit: 1 }).cursor;
  assert.ok(cursor2 !== null);
  left.update(1, "x"); // same key, but the version still bumps
  assert.throws(() => joinQuery(left, right, { limit: 1, cursor: cursor2 }), StaleCursorError);

  // And deletes too.
  const cursor3 = joinQuery(left, right, { limit: 1 }).cursor;
  assert.ok(cursor3 !== null);
  right.delete(3);
  assert.throws(() => joinQuery(left, right, { limit: 1, cursor: cursor3 }), StaleCursorError);
});

test("limit 0 returns an empty page with a valid resume cursor", () => {
  const left = new Table();
  const right = new Table();
  left.insert({ id: 1, key: 1 });
  right.insert({ id: 1, key: 1 });

  const page = joinQuery(left, right, { limit: 0 });
  assert.deepEqual(page.rows, []);
  assert.ok(page.cursor !== null);
  assert.equal(page.cursor.last, null);

  const rest = joinQuery(left, right, { cursor: page.cursor });
  assert.deepEqual(rest.rows, [{ key: 1, leftId: 1, rightId: 1 }]);
  assert.equal(rest.cursor, null);
});

test("empty tables and exhausted joins yield a null cursor", () => {
  const left = new Table();
  const right = new Table();
  assert.deepEqual(joinQuery(left, right), { rows: [], cursor: null });

  left.insert({ id: 1, key: "only-left" });
  assert.deepEqual(joinQuery(left, right), { rows: [], cursor: null });
});

// Deterministic PRNG (mulberry32) so failures are reproducible.
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

test("randomized mutations + pagination match the snapshot full-join reference", () => {
  const rand = mulberry32(0x5eed);
  const pick = (n: number) => Math.floor(rand() * n);
  const randomKey = () => {
    const roll = rand();
    if (roll < 0.2) return null;
    if (roll < 0.6) return pick(6); // small numeric domain -> many duplicates
    return `k${pick(6)}`;
  };

  for (let round = 0; round < 25; round += 1) {
    const left = new Table();
    const right = new Table();
    const liveIds: [Set<number>, Set<number>] = [new Set(), new Set()];
    let nextId = 1;

    const mutate = () => {
      const tableIndex = pick(2);
      const table = tableIndex === 0 ? left : right;
      const live = liveIds[tableIndex]!;
      const op = pick(3);
      if (op === 0 || live.size === 0) {
        const id = nextId;
        nextId += 1;
        table.insert({ id, key: randomKey() });
        live.add(id);
      } else if (op === 1) {
        const id = [...live][pick(live.size)]!;
        table.update(id, randomKey());
      } else {
        const id = [...live][pick(live.size)]!;
        table.delete(id);
        live.delete(id);
      }
    };

    for (let i = 0; i < 20; i += 1) mutate();

    // Interleave mutations with paginated reads over 10 rounds.
    for (let step = 0; step < 10; step += 1) {
      const pageSize = 1 + pick(7);
      const reference = fullJoin(left.snapshot(), right.snapshot());

      // Paginate through; a mutation mid-stream must fail the old cursor.
      const collected: JoinTriple[] = [];
      let cursor: Cursor | undefined;
      let guard = 0;
      for (;;) {
        guard += 1;
        assert.ok(guard <= reference.length + 2, "pagination must terminate");
        let page;
        try {
          page = joinQuery(left, right, { limit: pageSize, ...(cursor ? { cursor } : {}) });
        } catch (err) {
          assert.ok(err instanceof StaleCursorError, "only stale-cursor errors are expected");
          break; // tables changed mid-pagination: restart below
        }
        collected.push(...page.rows);
        if (page.cursor === null) {
          assert.deepEqual(collected, reference, `round ${round} step ${step}`);
          break;
        }
        cursor = page.cursor ?? undefined;
        if (rand() < 0.4) mutate(); // invalidate the cursor on purpose
      }

      // After any mid-stream mutation, a fresh full pagination still matches
      // a fresh snapshot reference.
      const freshReference = fullJoin(left.snapshot(), right.snapshot());
      assert.deepEqual(collectAll(left, right, pageSize), freshReference);
    }
  }
});
