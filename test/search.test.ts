import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SearchMerger,
  type Page,
  type SearchHit,
  type VersionEntry,
} from "../src/search.js";

/** A promise whose resolution is controlled explicitly by the test. */
class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolve(value: T): void {
    this.resolveFn(value);
  }

  reject(reason?: unknown): void {
    this.rejectFn(reason);
  }
}

function hit(id: string, score: number, version: number, withdrawn = false): SearchHit {
  return withdrawn ? { id, score, version, withdrawn } : { id, score, version };
}

function page(queryId: number, pageIndex: number, hits: SearchHit[]): Page {
  return { queryId, pageIndex, hits };
}

/**
 * Simulates one async fetch per page. Pages are materialised as Deferreds up
 * front, then resolved one by one in the given `order`, so the test fully
 * controls the interleaving in which the merger observes them.
 */
async function runQuery(
  merger: SearchMerger,
  queryId: number,
  pages: readonly Page[],
  order: readonly number[],
): Promise<void> {
  const pending = pages.map(() => new Deferred<Page>());
  const delivered = pending.map((deferred) =>
    deferred.promise.then((arrived) => merger.acceptPage(arrived)),
  );
  for (const index of order) {
    const target = pending[index];
    const payload = pages[index];
    if (target === undefined || payload === undefined) {
      throw new Error(`invalid page order index: ${index}`);
    }
    target.resolve(payload);
    // Yield so each page is merged before the next one is released.
    await Promise.resolve();
  }
  await Promise.all(delivered);
}

function permutations(length: number): number[][] {
  const items = Array.from({ length }, (_, index) => index);
  if (items.length <= 1) {
    return [items];
  }
  const result: number[][] = [];
  for (const item of items) {
    const rest = items.filter((candidate) => candidate !== item);
    for (const tail of permutations(rest.length)) {
      result.push([item, ...tail.map((index) => rest[index]!)]);
    }
  }
  return result;
}

const QUERY_PAGES: readonly Omit<Page, "queryId">[] = [
  {
    pageIndex: 0,
    hits: [hit("alpha", 9.5, 1), hit("beta", 7.0, 1), hit("gamma", 7.0, 2)],
  },
  {
    pageIndex: 1,
    hits: [hit("beta", 8.0, 3), hit("delta", 6.5, 1), hit("alpha", 9.0, 2)],
  },
  {
    pageIndex: 2,
    hits: [hit("gamma", 7.5, 4, true), hit("epsilon", 5.0, 1)],
  },
  {
    pageIndex: 3,
    hits: [hit("delta", 6.5, 2), hit("beta", 8.5, 2)],
  },
];

const EXPECTED_VERSION_TABLE: VersionEntry[] = [
  { id: "alpha", score: 9.0, version: 2, withdrawn: false },
  { id: "beta", score: 8.0, version: 3, withdrawn: false },
  { id: "delta", score: 6.5, version: 2, withdrawn: false },
  { id: "epsilon", score: 5.0, version: 1, withdrawn: false },
  { id: "gamma", score: 7.5, version: 4, withdrawn: true },
];

const EXPECTED_RESULTS = [
  { id: "alpha", score: 9.0, version: 2 },
  { id: "beta", score: 8.0, version: 3 },
  { id: "delta", score: 6.5, version: 2 },
  { id: "epsilon", score: 5.0, version: 1 },
];

const EXPECTED_TOMBSTONES = [{ id: "gamma", score: 7.5, version: 4 }];

test("every page arrival order converges to the same version table", async () => {
  const orders = permutations(QUERY_PAGES.length);
  assert.equal(orders.length, 24);
  for (const order of orders) {
    const merger = new SearchMerger();
    const queryId = merger.beginQuery();
    const pages = QUERY_PAGES.map((p) => ({ ...p, queryId }));
    await runQuery(merger, queryId, pages, order);
    assert.deepEqual(
      merger.versionTable(),
      EXPECTED_VERSION_TABLE,
      `version table mismatch for arrival order ${order.join(",")}`,
    );
    assert.deepEqual(merger.results(), EXPECTED_RESULTS);
    assert.deepEqual(merger.tombstones(), EXPECTED_TOMBSTONES);
  }
});

test("results sort by score descending, then id ascending", () => {
  const merger = new SearchMerger();
  const queryId = merger.beginQuery();
  merger.acceptPage(
    page(queryId, 0, [
      hit("b", 3.0, 1),
      hit("a", 3.0, 1),
      hit("c", 5.0, 1),
      hit("d", 1.0, 1),
    ]),
  );
  assert.deepEqual(
    merger.results().map((entry) => entry.id),
    ["c", "a", "b", "d"],
  );
});

test("newer version replaces older; withdrawn version forms a tombstone", () => {
  const merger = new SearchMerger();
  const queryId = merger.beginQuery();
  merger.acceptPage(page(queryId, 0, [hit("x", 4.0, 1), hit("y", 2.0, 5)]));
  merger.acceptPage(
    page(queryId, 1, [hit("x", 9.0, 3, true), hit("y", 1.0, 2, true)]),
  );
  // x: v3 withdrawn shadows v1 -> tombstone. y: v5 live beats stale v2 withdrawal.
  assert.deepEqual(merger.results(), [{ id: "y", score: 2.0, version: 5 }]);
  assert.deepEqual(merger.tombstones(), [{ id: "x", score: 9.0, version: 3 }]);
  assert.deepEqual(merger.versionTable(), [
    { id: "x", score: 9.0, version: 3, withdrawn: true },
    { id: "y", score: 2.0, version: 5, withdrawn: false },
  ]);
});

test("duplicate page delivery is ignored", () => {
  const merger = new SearchMerger();
  const queryId = merger.beginQuery();
  assert.equal(merger.acceptPage(page(queryId, 0, [hit("a", 1.0, 1)])), "accepted");
  assert.equal(
    merger.acceptPage(page(queryId, 0, [hit("a", 99.0, 9)])),
    "duplicate-page",
  );
  assert.deepEqual(merger.results(), [{ id: "a", score: 1.0, version: 1 }]);
});

test("cancelled query: late pages never enter the next query", async () => {
  const merger = new SearchMerger();
  const firstQuery = merger.beginQuery();

  // Pages for the first query are in flight but not yet resolved.
  const latePageA = new Deferred<Page>();
  const latePageB = new Deferred<Page>();
  const verdicts: string[] = [];
  const deliveries = [
    latePageA.promise.then((p) => verdicts.push(merger.acceptPage(p))),
    latePageB.promise.then((p) => verdicts.push(merger.acceptPage(p))),
  ];

  merger.acceptPage(page(firstQuery, 0, [hit("stale-live", 5.0, 1)]));
  merger.cancel();
  assert.deepEqual(merger.results(), []);

  const secondQuery = merger.beginQuery();
  merger.acceptPage(page(secondQuery, 0, [hit("fresh", 8.0, 1)]));

  // The old query's pages finally arrive; both must be rejected.
  latePageA.resolve(page(firstQuery, 1, [hit("stale-late", 9.9, 9)]));
  latePageB.resolve(page(firstQuery, 2, [hit("fresh", 0.1, 99, true)]));
  await Promise.all(deliveries);

  assert.deepEqual(verdicts, ["stale-query", "stale-query"]);
  assert.deepEqual(merger.results(), [{ id: "fresh", score: 8.0, version: 1 }]);
  assert.deepEqual(merger.tombstones(), []);
  assert.deepEqual(merger.versionTable(), [
    { id: "fresh", score: 8.0, version: 1, withdrawn: false },
  ]);
});

test("starting a new query invalidates the previous token", () => {
  const merger = new SearchMerger();
  const firstQuery = merger.beginQuery();
  merger.acceptPage(page(firstQuery, 0, [hit("old", 1.0, 1)]));
  const secondQuery = merger.beginQuery();
  assert.notEqual(secondQuery, firstQuery);
  assert.equal(
    merger.acceptPage(page(firstQuery, 1, [hit("old-late", 2.0, 2)])),
    "stale-query",
  );
  assert.deepEqual(merger.results(), []);
});
