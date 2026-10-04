import { describe, test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { CursorQueryMismatchError, InvalidCursorError, SearchIndex, StaleCursorError, compareHits, queryDigest, } from "../src/index.js";
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const VOCAB = ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape"];
function makeCorpus(count, seed = 42) {
    const rand = mulberry32(seed);
    const docs = [];
    for (let n = 0; n < count; n += 1) {
        const words = [];
        const len = 1 + Math.floor(rand() * 12);
        for (let w = 0; w < len; w += 1) {
            words.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
        }
        docs.push({ id: `doc-${String(n).padStart(4, "0")}`, text: words.join(" ") });
    }
    return docs;
}
function collectPages(index, query, limit, budget) {
    const hits = [];
    let cursor = undefined;
    let pages = 0;
    for (;;) {
        const page = index.search(query, { limit, cursor, budget });
        ok(page.complete, "expected a complete page with unlimited budget");
        hits.push(...page.hits);
        pages += 1;
        if (page.nextCursor === null)
            break;
        cursor = page.nextCursor;
        ok(pages < 10_000, "pagination did not terminate");
    }
    return { hits, pages };
}
describe("stable ordering", () => {
    test("ties on score are broken by id ascending, total order is deterministic", () => {
        const index = new SearchIndex([
            { id: "b", text: "apple" },
            { id: "a", text: "apple" },
            { id: "d", text: "apple apple" },
            { id: "c", text: "apple" },
            { id: "e", text: "banana" },
        ]);
        const hits = index.fullScan("apple");
        deepEqual(hits.map((h) => h.id), ["d", "a", "b", "c"]);
        // Repeating the search yields byte-identical ordering.
        deepEqual(index.fullScan("apple"), hits);
        // compareHits imposes a total order: antisymmetric and consistent.
        for (const x of hits) {
            for (const y of hits) {
                const forward = compareHits(x, y);
                const backward = compareHits(y, x);
                equal(Math.sign(forward), -Math.sign(backward) || 0);
                equal(forward === 0, backward === 0);
            }
        }
    });
});
describe("cursor pagination vs independent full scan", () => {
    const index = new SearchIndex(makeCorpus(257));
    const query = "apple banana";
    const reference = index.fullScan(query);
    ok(reference.length > 50, "corpus should produce plenty of hits");
    for (const limit of [1, 3, 7, 64, 1000]) {
        test(`page size ${limit}: union equals full scan, order preserved, no duplicates`, () => {
            const { hits, pages } = collectPages(index, query, limit);
            // Order: concatenated pages equal the independent full scan exactly.
            deepEqual(hits, reference);
            // Union: same id set, no duplicates, nothing lost between pages.
            equal(new Set(hits.map((h) => h.id)).size, hits.length);
            deepEqual(new Set(hits.map((h) => h.id)), new Set(reference.map((h) => h.id)));
            equal(pages, Math.ceil(reference.length / limit));
        });
    }
    test("query with no matches yields one empty, complete page and no cursor", () => {
        const page = index.search("zzz-no-such-term", { limit: 10 });
        deepEqual(page.hits, []);
        equal(page.nextCursor, null);
        equal(page.complete, true);
    });
});
describe("cursor binding", () => {
    test("cursor is rejected after the index changes (stale version)", () => {
        const index = new SearchIndex(makeCorpus(30));
        const first = index.search("apple", { limit: 5 });
        ok(first.nextCursor !== null);
        index.add({ id: "doc-new", text: "apple apple apple" });
        throws(() => index.search("apple", { limit: 5, cursor: first.nextCursor }), (err) => err instanceof StaleCursorError);
    });
    test("update and remove also invalidate cursors", () => {
        const index = new SearchIndex(makeCorpus(30));
        const c1 = index.search("apple", { limit: 5 }).nextCursor;
        index.update("doc-0000", "fig");
        throws(() => index.search("apple", { limit: 5, cursor: c1 }), StaleCursorError);
        const c2 = index.search("apple", { limit: 5 }).nextCursor;
        index.remove("doc-0001");
        throws(() => index.search("apple", { limit: 5, cursor: c2 }), StaleCursorError);
    });
    test("cursor is bound to the query digest", () => {
        const index = new SearchIndex(makeCorpus(30));
        const cursor = index.search("apple", { limit: 5 }).nextCursor;
        throws(() => index.search("banana", { limit: 5, cursor }), (err) => err instanceof CursorQueryMismatchError);
        // Same words, different formatting: same digest, cursor still valid.
        const reformatted = index.search("  APPLE ", { limit: 5, cursor });
        ok(reformatted.complete);
        equal(queryDigest("apple"), queryDigest("  APPLE "));
    });
    test("malformed and foreign cursors are rejected", () => {
        const index = new SearchIndex(makeCorpus(30));
        throws(() => index.search("apple", { limit: 5, cursor: "not-a-cursor" }), InvalidCursorError);
        const other = new SearchIndex(makeCorpus(30));
        const foreign = other.search("apple", { limit: 5 }).nextCursor;
        throws(() => index.search("apple", { limit: 5, cursor: foreign }), StaleCursorError);
    });
});
describe("budget accounting", () => {
    test("insufficient budget returns an incomplete (not closed) page", () => {
        const corpus = makeCorpus(100);
        const index = new SearchIndex(corpus);
        const page = index.search("apple", { limit: 10, budget: 20 });
        equal(page.complete, false);
        equal(page.incompleteReason, "budget_exhausted");
        equal(page.scanned, 20);
        equal(page.total, 100);
        // Continuation is still offered: nothing is permanently skipped.
        ok(page.nextCursor !== null);
    });
    test("budget covering the whole index closes the page", () => {
        const index = new SearchIndex(makeCorpus(100));
        const exact = index.search("apple", { limit: 10, budget: 100 });
        equal(exact.complete, true);
        equal(exact.incompleteReason, null);
        equal(exact.scanned, 100);
        const generous = index.search("apple", { limit: 10 });
        equal(generous.complete, true);
        deepEqual(exact.hits, generous.hits);
    });
    test("incomplete pages never silently drop unknown high-score items", () => {
        // Highest-scoring doc sits beyond the budget window; the page must
        // report incomplete rather than present a false "final" top list.
        const docs = makeCorpus(50);
        docs.push({ id: "doc-late", text: "apple apple apple apple apple" });
        const index = new SearchIndex(docs);
        const page = index.search("apple", { limit: 5, budget: 10 });
        equal(page.complete, false);
        ok(!page.hits.some((h) => h.id === "doc-late"));
        // With enough budget the same query surfaces doc-late at rank 1.
        const full = index.search("apple", { limit: 5 });
        equal(full.complete, true);
        equal(full.hits[0].id, "doc-late");
    });
    test("resuming with a cursor continues to spend budget honestly", () => {
        const index = new SearchIndex(makeCorpus(60));
        const first = index.search("apple", { limit: 5, budget: 30 });
        equal(first.complete, false);
        equal(first.scanned, 30);
        // Each request re-evaluates from the start and filters by the cursor
        // key, so a 30-doc budget is again exhausted before the tail is seen.
        const stillShort = index.search("apple", { limit: 5, cursor: first.nextCursor, budget: 30 });
        equal(stillShort.complete, false);
        const enough = index.search("apple", { limit: 5, cursor: first.nextCursor, budget: 60 });
        equal(enough.complete, true);
        equal(enough.scanned, 60);
    });
});
