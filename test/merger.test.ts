import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ResultMerger, type SearchHit, type SearchPage } from "../src/merger.js";
import { ControlledStream, fromDeferreds, Deferred, permutations } from "./helpers.js";

describe("ResultMerger sorting", () => {
  test("sorts by score descending, then id ascending", () => {
    const merger = new ResultMerger();
    merger.applyPage({
      hits: [
        { id: "b", score: 5, version: 1 },
        { id: "a", score: 5, version: 1 },
        { id: "c", score: 9, version: 1 },
        { id: "d", score: 1, version: 1 },
      ],
    });
    assert.deepEqual(
      merger.results().map((h) => h.id),
      ["c", "a", "b", "d"],
    );
  });
});

describe("ResultMerger versioning", () => {
  test("same id: newer version replaces older, regardless of arrival order", () => {
    for (const order of permutations([1, 2, 3])) {
      const merger = new ResultMerger();
      for (const version of order) {
        merger.applyHit({ id: "x", score: version * 10, version });
      }
      assert.deepEqual(merger.results(), [{ id: "x", score: 30, version: 3 }]);
    }
  });

  test("withdrawal removes the live hit and tombstones its version", () => {
    const merger = new ResultMerger();
    merger.applyHit({ id: "x", score: 7, version: 2 });
    merger.applyHit({ id: "x", score: 0, version: 2, withdrawn: true });
    assert.deepEqual(merger.results(), []);
    // The tombstoned version must not resurrect, even from a later page.
    merger.applyHit({ id: "x", score: 7, version: 2 });
    merger.applyHit({ id: "x", score: 9, version: 1 });
    assert.deepEqual(merger.results(), []);
    // A strictly newer version is still accepted.
    merger.applyHit({ id: "x", score: 8, version: 3 });
    assert.deepEqual(merger.results(), [{ id: "x", score: 8, version: 3 }]);
  });

  test("withdrawal arriving before the hit still suppresses it", () => {
    const merger = new ResultMerger();
    merger.applyHit({ id: "x", score: 0, version: 2, withdrawn: true });
    merger.applyHit({ id: "x", score: 7, version: 2 });
    merger.applyHit({ id: "x", score: 7, version: 1 });
    assert.deepEqual(merger.results(), []);
  });

  test("withdrawing a newer version also removes an older live hit", () => {
    const merger = new ResultMerger();
    merger.applyHit({ id: "x", score: 7, version: 1 });
    merger.applyHit({ id: "x", score: 0, version: 3, withdrawn: true });
    assert.deepEqual(merger.results(), []);
  });
});

/**
 * Version table: the ground truth every arrival order is checked against.
 * Expected winner per id = highest live version strictly above the highest
 * withdrawn version of that id.
 */
const VERSION_TABLE: Record<string, Array<{ version: number; score: number; withdrawn?: boolean }>> = {
  alpha: [
    { version: 1, score: 50 },
    { version: 2, score: 80, withdrawn: true },
    { version: 3, score: 70 },
  ],
  beta: [
    { version: 1, score: 60 },
    { version: 2, score: 90 },
  ],
  gamma: [
    { version: 1, score: 40 },
    { version: 2, score: 30, withdrawn: true },
  ],
  delta: [{ version: 1, score: 80 }],
};

function expectedFromTable(table: typeof VERSION_TABLE): SearchHit[] {
  const expected: SearchHit[] = [];
  for (const [id, versions] of Object.entries(table)) {
    const tombstone = Math.max(0, ...versions.filter((v) => v.withdrawn).map((v) => v.version));
    const live = versions.filter((v) => !v.withdrawn && v.version > tombstone);
    if (live.length === 0) continue;
    const best = live.reduce((a, b) => (b.version > a.version ? b : a));
    expected.push({ id, score: best.score, version: best.version });
  }
  return expected.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

// Hits of the table scattered across pages (pages arrive asynchronously).
const PAGES: SearchPage[] = [
  { hits: [{ id: "alpha", score: 50, version: 1 }, { id: "beta", score: 60, version: 1 }] },
  { hits: [{ id: "alpha", score: 80, version: 2, withdrawn: true }, { id: "delta", score: 80, version: 1 }] },
  { hits: [{ id: "gamma", score: 40, version: 1 }, { id: "beta", score: 90, version: 2 }] },
  { hits: [{ id: "alpha", score: 70, version: 3 }, { id: "gamma", score: 30, version: 2, withdrawn: true }] },
];

describe("ResultMerger vs version table", () => {
  test("every page arrival order converges to the version table", () => {
    const expected = expectedFromTable(VERSION_TABLE);
    for (const order of permutations(PAGES)) {
      const merger = new ResultMerger();
      for (const page of order) merger.applyPage(page);
      assert.deepEqual(merger.results(), expected, `order: ${JSON.stringify(order)}`);
    }
  });

  test("deferred promises resolved in any order converge to the version table", async () => {
    const expected = expectedFromTable(VERSION_TABLE);
    for (const order of permutations([0, 1, 2, 3])) {
      const deferreds = PAGES.map(() => new Deferred<SearchPage>());
      const merger = new ResultMerger();
      const collected = (async () => {
        for await (const page of fromDeferreds(deferreds)) merger.applyPage(page);
      })();
      for (const index of order) deferreds[index]!.resolve(PAGES[index]!);
      await collected;
      assert.deepEqual(merger.results(), expected, `resolve order: ${order}`);
    }
  });

  test("controlled stream pushed in any order converges to the version table", async () => {
    const expected = expectedFromTable(VERSION_TABLE);
    for (const order of permutations([0, 1, 2, 3])) {
      const stream = new ControlledStream();
      const merger = new ResultMerger();
      const collected = (async () => {
        for await (const page of stream) merger.applyPage(page);
      })();
      for (const index of order) stream.push(PAGES[index]!);
      stream.close();
      await collected;
      assert.deepEqual(merger.results(), expected, `push order: ${order}`);
    }
  });
});
