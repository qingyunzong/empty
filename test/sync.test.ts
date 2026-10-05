import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "../src/sync.js";
import { FileStorageAdapter, WRITE_BOUNDARIES } from "../src/fileStorage.js";
import { MemoryStorageAdapter } from "../src/memoryStorage.js";
import { CrashInjector } from "../src/interruptible.js";
import { CrashError, PageConflictError } from "../src/errors.js";
import type { Page, Snapshot } from "../src/types.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "offline-sync-"));
}

/** Deterministic page feed: 6 pages x 4 records, cursor per page. */
function makePages(): Page[] {
  const pages: Page[] = [];
  for (let p = 0; p < 6; p += 1) {
    const changes = [];
    for (let r = 0; r < 4; r += 1) {
      const n = p * 4 + r;
      changes.push({ id: `rec-${n}`, content: `content-v1-${n}` });
    }
    pages.push({ changes, nextCursor: `cursor-${p + 1}` });
  }
  return pages;
}

function applyAll(engine: SyncEngine, pages: Page[]): void {
  for (const page of pages) {
    engine.applyPage(page);
  }
}

/** Reference: one uninterrupted sequential application of every page. */
function referenceApply(pages: Page[]): Snapshot {
  const engine = new SyncEngine(new MemoryStorageAdapter());
  applyAll(engine, pages);
  return engine.snapshot();
}

test("commits a page's changes and cursor in one batch", () => {
  const dir = freshDir();
  try {
    const engine = new SyncEngine(new FileStorageAdapter(dir));
    engine.applyPage({
      changes: [
        { id: "a", content: "1" },
        { id: "b", content: "2" },
      ],
      nextCursor: "c1",
    });
    assert.deepEqual(engine.snapshot(), {
      records: { a: "1", b: "2" },
      cursor: "c1",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-applying the same page is idempotent", () => {
  const dir = freshDir();
  try {
    const engine = new SyncEngine(new FileStorageAdapter(dir));
    const page: Page = {
      changes: [
        { id: "a", content: "1" },
        { id: "b", content: "2" },
      ],
      nextCursor: "c1",
    };
    engine.applyPage(page);
    const once = engine.snapshot();
    engine.applyPage(page);
    engine.applyPage(page);
    assert.deepEqual(engine.snapshot(), once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same id with different content rejects the whole page", () => {
  const dir = freshDir();
  try {
    const engine = new SyncEngine(new FileStorageAdapter(dir));
    engine.applyPage({
      changes: [{ id: "a", content: "1" }],
      nextCursor: "c1",
    });
    const before = engine.snapshot();

    assert.throws(
      () =>
        engine.applyPage({
          changes: [
            { id: "b", content: "new" }, // would be new
            { id: "a", content: "CHANGED" }, // conflicts
          ],
          nextCursor: "c2",
        }),
      PageConflictError,
    );

    // Nothing from the rejected page may be committed.
    assert.deepEqual(engine.snapshot(), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conflicting duplicate id inside one page rejects the page", () => {
  const engine = new SyncEngine(new MemoryStorageAdapter());
  assert.throws(
    () =>
      engine.applyPage({
        changes: [
          { id: "a", content: "1" },
          { id: "a", content: "2" },
        ],
        nextCursor: "c1",
      }),
    PageConflictError,
  );
  assert.deepEqual(engine.snapshot(), { records: {}, cursor: null });
});

test("recovery discards an uncommitted batch after a crash", () => {
  const dir = freshDir();
  try {
    const ok = new SyncEngine(new FileStorageAdapter(dir));
    ok.applyPage({ changes: [{ id: "a", content: "1" }], nextCursor: "c1" });

    // Crash at the very first boundary (before temp-write) of page 2.
    const injector = new CrashInjector(0);
    const crashing = new SyncEngine(
      new FileStorageAdapter(dir, { onBoundary: injector.hook }),
    );
    assert.throws(
      () =>
        crashing.applyPage({
          changes: [{ id: "b", content: "2" }],
          nextCursor: "c2",
        }),
      CrashError,
    );

    // Restart: a fresh adapter over the same directory recovers page 1 only.
    const restarted = new SyncEngine(new FileStorageAdapter(dir));
    assert.deepEqual(restarted.snapshot(), {
      records: { a: "1" },
      cursor: "c1",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart at every write boundary matches one sequential apply", () => {
  const pages = makePages();
  const expected = referenceApply(pages);

  // First, count the write boundaries of a clean run.
  const counter = new CrashInjector(Infinity);
  const countDir = freshDir();
  try {
    applyAll(
      new SyncEngine(
        new FileStorageAdapter(countDir, { onBoundary: counter.hook }),
      ),
      pages,
    );
  } finally {
    rmSync(countDir, { recursive: true, force: true });
  }
  const totalBoundaries = counter.count;
  assert.equal(totalBoundaries, pages.length * WRITE_BOUNDARIES.length);

  // Then crash at each boundary in turn, restart, and finish the feed.
  for (let crashAt = 0; crashAt < totalBoundaries; crashAt += 1) {
    const dir = freshDir();
    try {
      const injector = new CrashInjector(crashAt);
      const interrupted = new SyncEngine(
        new FileStorageAdapter(dir, { onBoundary: injector.hook }),
      );
      assert.throws(() => applyAll(interrupted, pages), CrashError);

      // Restart with a fresh adapter over the same directory and re-run
      // the whole feed; already-committed pages replay idempotently.
      const restarted = new SyncEngine(new FileStorageAdapter(dir));
      applyAll(restarted, pages);

      const actual = restarted.snapshot();
      assert.deepEqual(
        actual,
        expected,
        `state mismatch after crash at boundary #${crashAt}`,
      );
      // No record may be skipped.
      assert.equal(
        Object.keys(actual.records).length,
        pages.reduce((n, p) => n + p.changes.length, 0),
      );
      assert.equal(actual.cursor, pages[pages.length - 1]!.nextCursor);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
