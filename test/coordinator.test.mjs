import assert from "node:assert/strict";
import test from "node:test";

import {
  AliasVerificationError,
  CatchUpNotConvergedError,
  InMemoryGapJournal,
  IndexGenerationCoordinator,
  OpenGapError,
  SwitchAlreadyAttemptedError,
} from "../.test-build/index.js";

class FakeBackend {
  aliases = { read: "index-old", write: "index-old" };
  calls = [];
  applied = [];
  deleted = [];
  failTargetVersions = new Set();
  verifyResult = true;

  async createGeneration(request) {
    this.calls.push(["createGeneration", request.id]);
    return { id: request.id };
  }

  async backfill(generation) {
    this.calls.push(["backfill", generation]);
    return { sourceVersion: 10, completed: true };
  }

  async applyChanges(generation, changes, context) {
    this.calls.push([
      "applyChanges",
      generation,
      changes.map((change) => change.sourceVersion),
      context.reason,
    ]);

    if (
      generation === this.targetId &&
      changes.some((change) => this.failTargetVersions.has(change.sourceVersion))
    ) {
      throw new Error(`target rejected ${changes[0].sourceVersion}`);
    }

    this.applied.push({
      generation,
      versions: changes.map((change) => change.sourceVersion),
      reason: context.reason,
    });
  }

  async getAliases() {
    return { ...this.aliases };
  }

  async compareAndSwapAliases(expected, target) {
    this.calls.push(["compareAndSwapAliases", expected, target]);
    if (
      this.aliases.read !== expected.read ||
      this.aliases.write !== expected.write
    ) {
      return false;
    }
    this.aliases = { read: target, write: target };
    return { swapped: true, aliases: { ...this.aliases } };
  }

  async verifyReadback(generation) {
    this.calls.push(["verifyReadback", generation]);
    return this.verifyResult;
  }

  async deleteGeneration(generation) {
    this.calls.push(["deleteGeneration", generation]);
    this.deleted.push(generation);
  }
}

class ArrayChangeFeed {
  constructor(changes, highWatermark) {
    this.changes = changes;
    this.highWatermark = highWatermark;
  }

  async readChanges({ afterVersion, throughVersion, limit }) {
    return this.changes
      .filter(
        (change) =>
          change.sourceVersion > afterVersion &&
          (throughVersion === undefined ||
            change.sourceVersion <= throughVersion),
      )
      .sort((left, right) => left.sourceVersion - right.sourceVersion)
      .slice(0, limit);
  }

  async getHighWatermark() {
    return this.highWatermark;
  }
}

function makeCoordinator({
  changes = [],
  highWatermark = 10,
  readerLeases,
  now,
  maxCatchUpRounds,
  journal,
} = {}) {
  const backend = new FakeBackend();
  backend.targetId = "index-new";
  const coordinator = new IndexGenerationCoordinator({
    backend,
    changeFeed: new ArrayChangeFeed(changes, highWatermark),
    targetGeneration: "index-new",
    pageSize: 2,
    readerLeases,
    gapJournal: journal,
    now,
    maxCatchUpRounds,
  });
  return { backend, coordinator };
}

test("backfills, replays changes in source-version order, then switches once", async () => {
  const changes = [
    { id: "c12", sourceVersion: 12, documentId: "doc-12" },
    { id: "c11a", sourceVersion: 11, documentId: "doc-11a" },
    { id: "c11b", sourceVersion: 11, documentId: "doc-11b" },
  ];
  const { backend, coordinator } = makeCoordinator({
    changes,
    highWatermark: 12,
    readerLeases: { getActiveLeases: async () => [] },
  });

  const result = await coordinator.run();

  const backfillIndex = backend.calls.findIndex(
    ([name]) => name === "backfill",
  );
  const applyCalls = backend.calls.filter(
    ([name]) => name === "applyChanges",
  );
  assert.ok(applyCalls.length > 0);
  assert.ok(backfillIndex >= 0);
  assert.deepEqual(
    applyCalls.flatMap(([, generation, versions]) =>
      versions.map((version) => [generation, version]),
    ),
    [
      ["index-new", 11],
      ["index-new", 11],
      ["index-new", 12],
    ],
  );

  const swaps = backend.calls.filter(
    ([name]) => name === "compareAndSwapAliases",
  );
  assert.equal(swaps.length, 1);
  assert.deepEqual(swaps[0][1], { read: "index-old", write: "index-old" });
  assert.deepEqual(backend.aliases, {
    read: "index-new",
    write: "index-new",
  });
  assert.deepEqual(backend.deleted, ["index-old"]);
  assert.equal(result.appliedChanges, 3);
  assert.equal(result.previousAliases.read, "index-old");
  assert.equal(result.aliases.read, "index-new");
});

test("dual-write target failure is retained and blocks switching until recovered", async () => {
  const journal = new InMemoryGapJournal();
  const { backend, coordinator } = makeCoordinator({
    highWatermark: 10,
    readerLeases: { getActiveLeases: () => [] },
    journal,
  });
  backend.failTargetVersions.add(13);

  await coordinator.backfill();
  const dualWrite = await coordinator.dualWrite({
    id: "c13",
    sourceVersion: 13,
    documentId: "doc-13",
    operation: "upsert",
  });

  assert.equal(dualWrite.status, "gap");
  assert.equal((await journal.list("index-new")).length, 1);
  assert.ok(
    backend.calls.some(
      ([name, generation, , reason]) =>
        name === "applyChanges" &&
        generation === "index-old" &&
        reason === "dual-write",
    ),
  );

  const caughtUp = await coordinator.catchUp();
  assert.equal(caughtUp.openGapCount, 1);
  await assert.rejects(coordinator.switchAliases(), OpenGapError);

  backend.failTargetVersions.clear();
  const recovery = await coordinator.retryOpenGaps();
  assert.deepEqual(recovery.recoveredGapIds, ["index-new:id:c13"]);
  assert.deepEqual(await journal.list("index-new"), []);

  const switched = await coordinator.switchAliases();
  assert.equal(switched.targetGeneration, "index-new");
  assert.deepEqual(backend.aliases, {
    read: "index-new",
    write: "index-new",
  });
});

test("recovers dual-write gaps after replaying earlier source versions", async () => {
  const { backend, coordinator } = makeCoordinator({
    changes: [
      { id: "c11", sourceVersion: 11, documentId: "doc-11" },
      { id: "c12", sourceVersion: 12, documentId: "doc-12" },
    ],
    highWatermark: 12,
    readerLeases: { getActiveLeases: () => [] },
  });
  backend.failTargetVersions.add(13);

  await coordinator.backfill();
  const dualWrite = await coordinator.dualWrite({
    id: "c13",
    sourceVersion: 13,
    documentId: "doc-13",
  });
  assert.equal(dualWrite.status, "gap");

  backend.failTargetVersions.clear();
  const caughtUp = await coordinator.catchUp();
  assert.equal(caughtUp.openGapCount, 0);

  const targetWrites = backend.applied
    .filter((entry) => entry.generation === "index-new")
    .flatMap((entry) => entry.versions);
  assert.deepEqual(targetWrites, [11, 12, 13]);
});

test("does not delete a retired generation while a reader lease is active", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const lease = {
    id: "reader-1",
    generation: "index-old",
    expiresAt: "2026-01-01T00:00:01.000Z",
  };
  const readerLeases = {
    getActiveLeases(generation, at) {
      return generation === "index-old" && new Date(lease.expiresAt) > at
        ? [lease]
        : [];
    },
  };
  const { backend, coordinator } = makeCoordinator({
    readerLeases,
    now: () => now,
  });

  const result = await coordinator.run();
  assert.deepEqual(backend.deleted, []);
  assert.deepEqual(result.cleanup.retainedGenerations, [
    {
      generation: "index-old",
      reason: "active-reader-leases",
      activeLeaseCount: 1,
    },
  ]);

  const cleanup = await coordinator.cleanupRetiredGenerations(
    new Date("2026-01-01T00:00:02.000Z"),
  );
  assert.deepEqual(cleanup.deletedGenerations, ["index-old"]);
  assert.deepEqual(backend.deleted, ["index-old"]);
});

test("verification failure never causes a second alias switch", async () => {
  const { backend, coordinator } = makeCoordinator({
    readerLeases: { getActiveLeases: () => [] },
  });
  backend.verifyResult = false;

  await assert.rejects(coordinator.run(), AliasVerificationError);
  assert.equal(
    backend.calls.filter(([name]) => name === "compareAndSwapAliases").length,
    1,
  );
  assert.deepEqual(backend.deleted, []);

  await assert.rejects(
    coordinator.switchAliases(),
    SwitchAlreadyAttemptedError,
  );
  assert.equal(
    backend.calls.filter(([name]) => name === "compareAndSwapAliases").length,
    1,
  );
});

test("refuses to switch when the high watermark keeps advancing", async () => {
  const backend = new FakeBackend();
  backend.targetId = "index-new";
  let watermark = 10;
  const coordinator = new IndexGenerationCoordinator({
    backend,
    changeFeed: {
      readChanges: async () => [],
      getHighWatermark: async () => {
        watermark += 1;
        return watermark;
      },
    },
    targetGeneration: "index-new",
    maxCatchUpRounds: 2,
    readerLeases: { getActiveLeases: () => [] },
  });

  await assert.rejects(coordinator.run(), CatchUpNotConvergedError);
  assert.equal(
    backend.calls.filter(([name]) => name === "compareAndSwapAliases").length,
    0,
  );
});

test("incomplete backfill is not replayable or switchable", async () => {
  const backend = new FakeBackend();
  backend.backfill = async () => ({ sourceVersion: 10, completed: false });
  const coordinator = new IndexGenerationCoordinator({
    backend,
    changeFeed: new ArrayChangeFeed([], 10),
    targetGeneration: "index-new",
  });

  await assert.rejects(coordinator.run(), /did not complete/);
  assert.equal(
    backend.calls.filter(([name]) => name === "applyChanges").length,
    0,
  );
  assert.equal(
    backend.calls.filter(([name]) => name === "compareAndSwapAliases").length,
    0,
  );
});
