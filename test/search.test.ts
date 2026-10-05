import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SearchIndex,
  search,
  fullScan,
  compareHits,
  queryDigest,
  MalformedCursorError,
  StaleCursorError,
  QueryMismatchError,
  type Hit,
  type Query,
} from "../src/search.ts";

const QUERY: Query = { term: "x" };

function docWithScore(id: string, score: number) {
  return { id, text: "x ".repeat(score).trim() };
}

function makeIndex(): SearchIndex {
  const index = new SearchIndex();
  const scores = [3, 1, 2, 2, 0, 5, 3, 1, 2, 4, 0, 2];
  scores.forEach((score, i) => {
    index.add(docWithScore(`d${String(i + 1).padStart(2, "0")}`, score));
  });
  return index;
}

function collectAllPages(
  index: SearchIndex,
  query: Query,
  limit: number,
  budget?: number,
): Hit[] {
  const all: Hit[] = [];
  let cursor: string | undefined = undefined;
  for (let guard = 0; guard < 1000; guard++) {
    let result = search(index, query, { limit, budget, cursor });
    while (!result.closed) {
      assert.ok(result.nextCursor, "unclosed result must carry a cursor");
      assert.deepEqual(result.items, [], "unclosed result must not emit items");
      cursor = result.nextCursor!;
      result = search(index, query, { limit, budget, cursor });
    }
    all.push(...result.items);
    if (result.nextCursor === null) return all;
    cursor = result.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

function assertMatchesFullScan(index: SearchIndex, query: Query, pages: Hit[]) {
  const expected = fullScan(index, query);
  // Union: same multiset of ids.
  assert.deepEqual(
    pages.map((h) => h.id).sort(),
    expected.map((h) => h.id).sort(),
    "page union must equal the full-scan set",
  );
  // No duplicates.
  assert.equal(new Set(pages.map((h) => h.id)).size, pages.length);
  // Order: identical sequence, hence sorted by (score desc, id asc).
  assert.deepEqual(pages, expected, "page order must equal full-scan order");
  for (let i = 1; i < pages.length; i++) {
    assert.ok(compareHits(pages[i - 1], pages[i]) < 0);
  }
}

test("results are stably sorted by score desc then id asc", () => {
  const index = makeIndex();
  const result = search(index, QUERY, { limit: 100 });
  assert.ok(result.closed);
  const expected = fullScan(index, QUERY);
  assert.deepEqual(result.items, expected);
  // Ties on score must resolve to ascending id.
  const tied = result.items.filter((h) => h.score === 2).map((h) => h.id);
  assert.deepEqual(tied, ["d03", "d04", "d09", "d12"]);
});

test("paginated union and order match an independent full scan", () => {
  const index = makeIndex();
  for (const limit of [1, 2, 3, 4, 7, 100]) {
    const pages = collectAllPages(index, QUERY, limit);
    assertMatchesFullScan(index, QUERY, pages);
  }
});

test("non-matching docs are excluded from pages and full scan", () => {
  const index = makeIndex();
  const pages = collectAllPages(index, QUERY, 2);
  assert.ok(!pages.some((h) => h.id === "d05" || h.id === "d11"));
  assert.equal(pages.length, 10);
});

test("cursor is rejected after the index changes", () => {
  const index = makeIndex();
  const page1 = search(index, QUERY, { limit: 3 });
  assert.ok(page1.closed && page1.nextCursor);

  index.add(docWithScore("d13", 1));
  assert.throws(
    () => search(index, QUERY, { limit: 3, cursor: page1.nextCursor! }),
    StaleCursorError,
  );

  const fresh = search(index, QUERY, { limit: 3 });
  index.remove("d13");
  assert.throws(
    () => search(index, QUERY, { limit: 3, cursor: fresh.nextCursor! }),
    StaleCursorError,
  );
});

test("cursor is rejected for a different query", () => {
  const index = makeIndex();
  const page1 = search(index, QUERY, { limit: 3 });
  assert.ok(page1.nextCursor);
  assert.throws(
    () =>
      search(index, { term: "y" }, { limit: 3, cursor: page1.nextCursor! }),
    QueryMismatchError,
  );
});

test("malformed or tampered cursors are rejected", () => {
  const index = makeIndex();
  assert.throws(
    () => search(index, QUERY, { limit: 3, cursor: "not-a-cursor" }),
    MalformedCursorError,
  );
  const page1 = search(index, QUERY, { limit: 3 });
  const sealed = JSON.parse(
    Buffer.from(page1.nextCursor!, "base64url").toString("utf8"),
  );
  sealed.p.ks.score = 999;
  const tampered = Buffer.from(JSON.stringify(sealed), "utf8").toString(
    "base64url",
  );
  assert.throws(
    () => search(index, QUERY, { limit: 3, cursor: tampered }),
    MalformedCursorError,
  );
});

test("query digest is canonical with respect to key order", () => {
  const a = queryDigest({ term: "x" });
  const b = queryDigest(JSON.parse('{"term":"x"}'));
  assert.equal(a, b);
  assert.notEqual(a, queryDigest({ term: "y" }));
});

test("insufficient budget returns unclosed and skips nothing", () => {
  const index = new SearchIndex();
  index.add(docWithScore("low-a", 1));
  index.add(docWithScore("low-b", 1));
  index.add(docWithScore("mid", 2));
  // The highest-scoring doc sits at the very end of the scan order.
  index.add(docWithScore("top", 9));

  const first = search(index, QUERY, { limit: 2, budget: 3 });
  assert.equal(first.closed, false);
  assert.equal(first.scanned, 3);
  assert.deepEqual(first.items, [], "must not emit items while unclosed");
  assert.ok(first.nextCursor, "unclosed result must be resumable");

  const resumed = search(index, QUERY, {
    limit: 2,
    budget: 100,
    cursor: first.nextCursor!,
  });
  assert.equal(resumed.closed, true);
  // The unknown tail item outranks everything seen before the budget ran out.
  assert.deepEqual(
    resumed.items.map((h) => h.id),
    ["top", "mid"],
  );
});

test("tight budget across every page still matches the full scan", () => {
  const index = makeIndex();
  for (const budget of [1, 2, 5]) {
    const pages = collectAllPages(index, QUERY, 3, budget);
    assertMatchesFullScan(index, QUERY, pages);
  }
});

test("zero budget makes no progress but stays resumable", () => {
  const index = makeIndex();
  const result = search(index, QUERY, { limit: 3, budget: 0 });
  assert.equal(result.closed, false);
  assert.equal(result.scanned, 0);
  const resumed = search(index, QUERY, {
    limit: 3,
    cursor: result.nextCursor!,
  });
  assert.equal(resumed.closed, true);
  assert.deepEqual(resumed.items, fullScan(index, QUERY).slice(0, 3));
});

test("budget is rejected when negative and limit must be positive", () => {
  const index = makeIndex();
  assert.throws(() => search(index, QUERY, { limit: 0 }), RangeError);
  assert.throws(
    () => search(index, QUERY, { limit: 1, budget: -1 }),
    RangeError,
  );
});
