import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorageAdapter, InMemoryAdapter } from "../src/adapter.js";
import { RealDevice } from "../src/device.js";
import { CrashError, InterruptibleDevice } from "../src/interruptible.js";
import { applySequentially } from "../src/reference.js";
import { ConflictError, SyncEngine } from "../src/sync.js";
import type { Page, Snapshot } from "../src/types.js";

function makePages(pageCount: number, perPage: number): Page[] {
  const pages: Page[] = [];
  for (let p = 0; p < pageCount; p++) {
    const changes = [];
    for (let i = 0; i < perPage; i++) {
      changes.push({ id: `rec-${p}-${i}`, content: `content-${p}-${i}` });
    }
    pages.push({ changes, nextCursor: `cursor-${p + 1}` });
  }
  return pages;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "offline-sync-"));
}

function loadSnapshot(dir: string): Snapshot {
  return new FileStorageAdapter(dir, new RealDevice()).load();
}

test("commits changes and cursor in one batch", () => {
  const engine = new SyncEngine(new InMemoryAdapter());
  const page: Page = {
    changes: [
      { id: "a", content: "1" },
      { id: "b", content: "2" },
    ],
    nextCursor: "c1",
  };
  const result = engine.applyPage(page);
  deepEqual(result, { applied: true, cursor: "c1" });
  deepEqual(engine.snapshot(), {
    records: { a: "1", b: "2" },
    cursor: "c1",
    appliedCursors: ["c1"],
  });
});

test("page replay is idempotent, even after later pages applied", () => {
  const engine = new SyncEngine(new InMemoryAdapter());
  const page1: Page = {
    changes: [{ id: "a", content: "1" }],
    nextCursor: "c1",
  };
  const page2: Page = {
    changes: [{ id: "b", content: "2" }],
    nextCursor: "c2",
  };
  engine.applyPage(page1);
  const replay1 = engine.applyPage(page1);
  equal(replay1.applied, false);
  engine.applyPage(page2);
  const before = engine.snapshot();
  // Re-sending an older page after the cursor advanced must be a no-op,
  // not a cursor regression.
  equal(engine.applyPage(page1).applied, false);
  equal(engine.applyPage(page2).applied, false);
  deepEqual(engine.snapshot(), before);
  deepEqual(engine.snapshot(), {
    records: { a: "1", b: "2" },
    cursor: "c2",
    appliedCursors: ["c1", "c2"],
  });
});

test("same id with different content rejects the whole page", () => {
  const engine = new SyncEngine(new InMemoryAdapter());
  engine.applyPage({
    changes: [{ id: "a", content: "1" }],
    nextCursor: "c1",
  });
  const before = engine.snapshot();
  throws(
    () =>
      engine.applyPage({
        changes: [
          { id: "b", content: "new" },
          { id: "a", content: "CONFLICT" },
        ],
        nextCursor: "c2",
      }),
    ConflictError,
  );
  // Nothing from the rejected page leaked through: no "b", cursor unchanged.
  deepEqual(engine.snapshot(), before);
});

test("duplicate id with different content inside one page rejects the page", () => {
  const engine = new SyncEngine(new InMemoryAdapter());
  throws(
    () =>
      engine.applyPage({
        changes: [
          { id: "a", content: "1" },
          { id: "a", content: "2" },
        ],
        nextCursor: "c1",
      }),
    ConflictError,
  );
  deepEqual(engine.snapshot(), { records: {}, cursor: null, appliedCursors: [] });
});

const PAGES = makePages(3, 5);
const OPS_PER_COMMIT = 4; // writeTmp, fsyncFile, rename, fsyncDir
const BOUNDARIES = PAGES.length * OPS_PER_COMMIT;
const REFERENCE = applySequentially(PAGES);

function assertPrefixState(snapshot: Snapshot): void {
  const match = REFERENCE.prefixes.some(
    (prefix) => JSON.stringify(prefix) === JSON.stringify(snapshot),
  );
  ok(
    match,
    `state after restart must equal a prefix of the sequential run, got cursor=${snapshot.cursor}`,
  );
}

function runWithSingleCrash(dir: string, crashAt: number, torn: boolean): Snapshot {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const device = new InterruptibleDevice(
      new RealDevice(),
      attempt === 1 ? crashAt : null,
      torn,
    );
    const engine = new SyncEngine(new FileStorageAdapter(dir, device));
    try {
      for (const page of PAGES) engine.applyPage(page);
      break;
    } catch (error) {
      if (!(error instanceof CrashError)) throw error;
      assertPrefixState(loadSnapshot(dir)); // restart: recover and verify
    }
  }
  ok(attempt >= 2, "expected at least one crash and restart");
  return loadSnapshot(dir);
}

test("crash and restart at every write boundary matches sequential application", () => {
  for (let crashAt = 1; crashAt <= BOUNDARIES; crashAt++) {
    for (const torn of [false, true]) {
      const snapshot = runWithSingleCrash(freshDir(), crashAt, torn);
      deepEqual(
        snapshot,
        REFERENCE.final,
        `crash at boundary ${crashAt} (torn=${torn})`,
      );
    }
  }
});

test("repeated crashes never skip records and converge to the reference", () => {
  const dir = freshDir();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    // Deterministic rotating crash point; boundary 4 crashes after the
    // atomic rename, so that attempt's commit still lands and recovery
    // replays the page as a no-op.
    const crashAt = (attempt % OPS_PER_COMMIT) + 1;
    const device = new InterruptibleDevice(new RealDevice(), crashAt);
    const engine = new SyncEngine(new FileStorageAdapter(dir, device));
    try {
      for (const page of PAGES) engine.applyPage(page);
      break;
    } catch (error) {
      if (!(error instanceof CrashError)) throw error;
      assertPrefixState(loadSnapshot(dir));
      ok(attempt < 100, "recovery must make progress");
    }
  }
  ok(attempt > PAGES.length, "expected multiple crashes before converging");
  const snapshot = loadSnapshot(dir);
  deepEqual(snapshot, REFERENCE.final);
  equal(Object.keys(snapshot.records).length, 15);
  equal(snapshot.cursor, "cursor-3");
});

test("conflicting page during recovery still rejects and preserves state", () => {
  const dir = freshDir();
  const engine = () => new SyncEngine(new FileStorageAdapter(dir, new RealDevice()));
  engine().applyPage({ changes: [{ id: "x", content: "1" }], nextCursor: "c1" });
  // Simulate a restart, then a conflicting page arrives.
  throws(
    () =>
      engine().applyPage({
        changes: [{ id: "x", content: "different" }],
        nextCursor: "c2",
      }),
    ConflictError,
  );
  deepEqual(loadSnapshot(dir), {
    records: { x: "1" },
    cursor: "c1",
    appliedCursors: ["c1"],
  });
});
