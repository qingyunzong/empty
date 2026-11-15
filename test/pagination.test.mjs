import assert from "node:assert/strict";
import test from "node:test";
import {
  CursorInvalidationError,
  PaginationCapabilityError,
  PaginationProtocolError,
  PaginationRestartLimitError,
  collectConnection,
  isCursorInvalidationError,
} from "../dist/index.js";

const node = (id, value = 1) => ({ id, value });
const edge = (cursor, item) => ({ cursor, node: item });
const page = (edges, endCursor, options = {}) => ({
  edges,
  pageInfo: {
    hasNextPage: options.hasNextPage ?? endCursor !== null,
    endCursor,
    startCursor: edges[0]?.cursor ?? null,
    totalCount: options.totalCount ?? null,
  },
  snapshotToken:
    options.snapshotToken === undefined ? "snapshot-1" : options.snapshotToken,
});

test("collects a stable connection and reports its coverage interval", async () => {
  const pages = [
    page([edge("c1", node("a")), edge("c2", node("b"))], "c2", {
      totalCount: 4,
    }),
    page([edge("c3", node("c")), edge("c4", node("d"))], null, {
      totalCount: 4,
    }),
  ];
  const events = [];
  let index = 0;

  const result = await collectConnection({
    fetchPage: async () => pages[index++],
    first: 2,
    onPage: (event) => events.push(event),
  });

  assert.deepEqual(result.items.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.equal(result.receipt.complete, true);
  assert.equal(result.receipt.consistency, "snapshot-token");
  assert.deepEqual(result.receipt.warnings, []);
  assert.equal(result.receipt.restartCount, 0);
  assert.equal(result.receipt.coverage.startCursor, "c1");
  assert.equal(result.receipt.coverage.endCursor, "c4");
  assert.equal(result.receipt.coverage.startKey, "a");
  assert.equal(result.receipt.coverage.endKey, "d");
  assert.equal(result.receipt.coverage.pageCount, 2);
  assert.equal(result.receipt.coverage.edgeCount, 4);
  assert.equal(result.receipt.coverage.nodeCount, 4);
  assert.deepEqual(result.checkpoint.keys, ["a", "b", "c", "d"]);
  assert.equal(result.checkpoint.complete, true);
  assert.equal(result.checkpoint.endCursor, "c4");
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).checkpoint.complete, true);
});

test("restarts on a server snapshot token change and deduplicates the new pass", async () => {
  const fetchPage = async ({ pass, after }) => {
    if (pass === 1) {
      if (after === null) {
        return page([edge("c1", node("a")), edge("c2", node("b"))], "c2", {
          snapshotToken: "snapshot-1",
        });
      }
      return page([edge("c3", node("c")), edge("c4", node("d"))], null, {
        snapshotToken: "snapshot-2",
      });
    }
    if (after === null) {
      return page([edge("c1", node("a")), edge("c2", node("b"))], "c2", {
        snapshotToken: "snapshot-1",
      });
    }
    return page([edge("c3", node("c")), edge("c4", node("d"))], null, {
      snapshotToken: "snapshot-1",
    });
  };

  const result = await collectConnection({ fetchPage, first: 2 });

  assert.deepEqual(result.items.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.equal(result.receipt.restartCount, 1);
  assert.equal(result.receipt.passCount, 2);
  assert.equal(result.receipt.pagesFetched, 4);
  assert.equal(result.receipt.restarts[0].reason, "snapshot-token-changed");
  assert.equal(result.receipt.restarts[0].snapshotTokenBefore, "snapshot-1");
  assert.equal(result.receipt.restarts[0].snapshotTokenObserved, "snapshot-2");
  assert.deepEqual(result.receipt.restarts[0].observedKeys, ["a", "b", "c", "d"]);
  assert.equal(result.receipt.finalPass.snapshotToken, "snapshot-1");
  assert.deepEqual(result.receipt.snapshotTokens, ["snapshot-1", "snapshot-2"]);
});

test("restarts on an insertion and never returns the duplicate twice", async () => {
  const fetchPage = async ({ pass, after }) => {
    if (pass === 1) {
      if (after === null) {
        return page([edge("c1", node("a")), edge("c2", node("b"))], "c2", {
          totalCount: 2,
        });
      }
      return page([edge("c2", node("b")), edge("c3", node("c"))], null, {
        totalCount: 3,
      });
    }
    if (after === null) {
      return page([edge("c1", node("a")), edge("c2", node("b"))], "c2", {
        totalCount: 3,
      });
    }
    return page([edge("c3", node("c"))], null, { totalCount: 3 });
  };

  const result = await collectConnection({ fetchPage, first: 2 });

  assert.deepEqual(result.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(result.receipt.restartCount, 1);
  assert.equal(result.receipt.restarts[0].reason, "insertion-detected");
  assert.equal(result.receipt.restarts[0].detectedBy, "total-count");
  assert.equal(result.receipt.coverage.nodeCount, 3);
});

test("a declared stable insertion is deduplicated without a restart", async () => {
  const pages = [
    page([edge("c1", node("a")), edge("c2", node("b"))], "c2", { totalCount: 2 }),
    page([edge("c2", node("b")), edge("c3", node("c"))], null, { totalCount: 3 }),
  ];
  let index = 0;

  const result = await collectConnection({
    fetchPage: async () => pages[index++],
    capabilities: { insertStable: true },
  });

  assert.deepEqual(result.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(result.receipt.restartCount, 0);
  assert.equal(result.receipt.drifts[0].action, "continue");
  assert.equal(result.receipt.drifts[0].reason, "insertion-detected");
  assert.equal(result.receipt.duplicateSightings, 1);
});

test("a deletion restart keeps abandoned-pass observations visible", async () => {
  const fetchPage = async ({ pass, after }) => {
    if (pass === 1) {
      if (after === null) {
        return page(
          [edge("c1", node("a")), edge("c2", node("b")), edge("c3", node("c"))],
          "c3",
          { totalCount: 3 },
        );
      }
      return page([edge("c4", node("d"))], null, { totalCount: 2 });
    }
    if (after === null) {
      return page([edge("c1", node("a")), edge("c3", node("c"))], "c3", {
        totalCount: 2,
      });
    }
    return page([edge("c4", node("d"))], null, { totalCount: 2 });
  };

  const result = await collectConnection({ fetchPage, first: 3 });

  assert.deepEqual(result.items.map((item) => item.id), ["a", "c", "d"]);
  assert.equal(result.receipt.restartCount, 1);
  assert.equal(result.receipt.restarts[0].reason, "deletion-detected");
  assert.deepEqual(result.receipt.observedOnlyBeforeRestart, ["b"]);
  assert.ok(result.byKey.has("b"));
  assert.equal(result.byKey.get("b").inFinalPass, false);
});

test("same-key revisions retain every content generation", async () => {
  const pages = [
    page([edge("c1", node("a", 1))], "c1", { totalCount: 2 }),
    page([edge("c2", node("a", 2)), edge("c3", node("b", 1))], null, {
      totalCount: 2,
    }),
  ];
  let index = 0;

  const result = await collectConnection({ fetchPage: async () => pages[index++] });
  const record = result.byKey.get("a");

  assert.deepEqual(result.items.map((item) => item.id), ["a", "b"]);
  assert.equal(result.items[0].value, 2);
  assert.equal(record.revisions.length, 2);
  assert.deepEqual(record.revisions.map((revision) => revision.generation), [1, 2]);
  assert.deepEqual(record.revisions.map((revision) => revision.node.value), [1, 2]);
  assert.equal(record.latestGeneration, 2);
  assert.equal(result.receipt.revisionCount, 1);
  assert.equal(result.receipt.restartCount, 0);
  assert.equal(result.receipt.drifts[0].reason, "same-key-revision");
  assert.equal(result.receipt.consistency, "unverified");
});

test("an invalidated cursor restarts the pass from the beginning", async () => {
  const fetchPage = async ({ pass, after }) => {
    if (pass === 1) {
      if (after === null) {
        return page([edge("c1", node("a")), edge("c2", node("b"))], "c2");
      }
      throw new CursorInvalidationError("cursor expired", "CURSOR_EXPIRED");
    }
    if (after === null) {
      return page([edge("c1", node("a")), edge("c2", node("b"))], "c2");
    }
    return page([edge("c3", node("c"))], null);
  };

  const result = await collectConnection({ fetchPage, first: 2 });

  assert.equal(isCursorInvalidationError(new CursorInvalidationError()), true);
  assert.deepEqual(result.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(result.receipt.restartCount, 1);
  assert.equal(result.receipt.restarts[0].reason, "cursor-invalidated");
  assert.equal(result.receipt.restarts[0].detectedBy, "error");
  assert.equal(result.receipt.restarts[0].errorCode, "CURSOR_EXPIRED");
});

test("a declared non-invalidating cursor fails loudly", async () => {
  const fetchPage = async ({ after }) => {
    if (after === null) return page([edge("c1", node("a")), edge("c2", node("b"))], "c2");
    throw Object.assign(new Error("bad cursor"), {
      extensions: { code: "CURSOR_INVALID" },
    });
  };

  await assert.rejects(
    collectConnection({
      fetchPage,
      capabilities: { cursorCanInvalidate: false },
    }),
    PaginationCapabilityError,
  );
});

test("persistent drift stops at the restart limit", async () => {
  const fetchPage = async ({ after }) => {
    if (after === null) {
      return page([edge("c1", node("a"))], "c1", { snapshotToken: "s1" });
    }
    return page([edge("c2", node("b"))], null, { snapshotToken: "s2" });
  };

  await assert.rejects(
    collectConnection({ fetchPage, maxRestarts: 1 }),
    (error) => {
      assert.ok(error instanceof PaginationRestartLimitError);
      assert.equal(error.maxRestarts, 1);
      assert.equal(error.restarts.length, 1);
      assert.equal(error.evidence.reason, "snapshot-token-changed");
      return true;
    },
  );
});

test("requireSnapshotToken rejects a tokenless first page", async () => {
  await assert.rejects(
    collectConnection({
      fetchPage: async () =>
        page([edge("c1", node("a"))], null, { snapshotToken: null }),
      requireSnapshotToken: true,
    }),
    (error) => {
      assert.ok(error instanceof PaginationProtocolError);
      assert.equal(error.code, "SNAPSHOT_TOKEN_REQUIRED");
      return true;
    },
  );
});

test("a tokenless pass without stable capabilities is explicitly unverified", async () => {
  const pages = [
    page([edge("c1", node("a")), edge("c2", node("b"))], "c2", {
      snapshotToken: null,
    }),
    page([edge("c3", node("c"))], null, { snapshotToken: null }),
  ];
  let index = 0;

  const result = await collectConnection({ fetchPage: async () => pages[index++] });

  assert.equal(result.receipt.complete, true);
  assert.equal(result.receipt.consistency, "unverified");
  assert.equal(result.receipt.warnings.length, 1);
  assert.match(result.receipt.warnings[0], /same-count mutations/i);
});

test("declared stable insert and delete cursors provide declared coverage", async () => {
  const pages = [
    page([edge("c1", node("a"))], null, { snapshotToken: null }),
  ];
  let index = 0;

  const result = await collectConnection({
    fetchPage: async () => pages[index++],
    capabilities: { insertStable: true, deleteStable: true },
  });

  assert.equal(result.receipt.consistency, "declared-stable");
  assert.deepEqual(result.receipt.warnings, []);
});

test("a late snapshot token is recorded without claiming page-1 pinning", async () => {
  const pages = [
    page([edge("c1", node("a"))], "c1", { snapshotToken: null }),
    page([edge("c2", node("b"))], null, { snapshotToken: "late-token" }),
  ];
  let index = 0;

  const result = await collectConnection({ fetchPage: async () => pages[index++] });

  assert.equal(result.receipt.drifts[0].reason, "snapshot-token-appeared");
  assert.equal(result.receipt.drifts[0].snapshotTokenBefore, null);
  assert.equal(result.receipt.drifts[0].snapshotTokenObserved, "late-token");
  assert.equal(result.receipt.finalPass.pinnedSnapshotToken, false);
  assert.equal(result.receipt.consistency, "unverified");
});

test("node-only pages use the supplied cursor accessor", async () => {
  const pages = [
    { nodes: [{ id: "a", cursor: "c1" }], pageInfo: { hasNextPage: false, endCursor: "c1" } },
  ];
  let index = 0;

  const result = await collectConnection({
    fetchPage: async () => pages[index++],
    nodeKey: "id",
  });

  assert.deepEqual(result.items.map((item) => item.id), ["a"]);
  assert.equal(result.receipt.coverage.startCursor, "c1");
  assert.equal(result.receipt.coverage.endCursor, "c1");
});
