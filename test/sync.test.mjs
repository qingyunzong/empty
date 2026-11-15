import test from "node:test";
import assert from "node:assert/strict";

import {
  DeltaSyncError,
  MemoryDeltaStore,
  ODataDeltaSync,
} from "../dist/index.js";

const entity = (id, version, extra = {}) => ({
  "@odata.id": id,
  version,
  ...extra,
});

function makeFetcher(routes, failures = new Map()) {
  const calls = [];

  async function fetchPage(url) {
    calls.push(url);
    const remaining = failures.get(url) ?? 0;
    if (remaining > 0) {
      failures.set(url, remaining - 1);
      throw new Error(`network failure for ${url}`);
    }

    if (!Object.hasOwn(routes, url)) {
      throw new Error(`unexpected URL ${url}`);
    }
    const route = routes[url];
    return typeof route === "function" ? route() : route;
  }

  return { fetchPage, calls };
}

function assertSyncError(error, code) {
  assert.ok(error instanceof DeltaSyncError, "expected DeltaSyncError");
  assert.equal(error.code, code);
  assert.equal(error.resumable, true);
}

test("a complete round follows nextLink and commits only the final deltaLink", async () => {
  const store = new MemoryDeltaStore();
  const { fetchPage, calls } = makeFetcher({
    L0: {
      value: [
        entity("Things(1)", 1, { Name: "one" }),
        entity("Things(2)", 1, { Name: "two" }),
      ],
      "@odata.nextLink": "L1",
      "@odata.deltaLink": "INTERMEDIATE-MUST-NOT-WIN",
    },
    L1: {
      value: [
        entity("Things(1)", 2, { Name: "one-updated" }),
        {
          "@odata.id": "Things(2)",
          version: 2,
          "@removed": { reason: "deleted" },
        },
      ],
      "@odata.deltaLink": "D1",
    },
  });

  const observations = [];
  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
    onPage: (_page, _url, pageNumber) => {
      observations.push({
        pageNumber,
        records: store.listRecords("Things").length,
        cursor: store.getCursor("Things"),
      });
    },
  });

  const result = await sync.sync();

  assert.deepEqual(calls, ["L0", "L1"]);
  assert.deepEqual(observations, [
    { pageNumber: 1, records: 0, cursor: undefined },
    { pageNumber: 2, records: 0, cursor: undefined },
  ]);
  assert.equal(result.deltaLink, "D1");
  assert.equal(result.pages, 2);
  assert.equal(result.changes, 4);
  assert.equal(result.resumed, false);
  assert.equal(result.stats.received, 4);
  assert.equal(result.stats.applied, 4);
  assert.equal(result.stats.inserted, 2);
  assert.equal(result.stats.updated, 1);
  assert.equal(result.stats.removed, 1);
  assert.equal(store.getCursor("Things").deltaLink, "D1");
  assert.equal(sync.resumable, false);

  const live = store.listEntities("Things");
  assert.equal(live.length, 1);
  assert.equal(live[0].Name, "one-updated");
  assert.equal(store.getRecord("Things", "Things(2)").deleted, true);
});

test("a mid-chain failure resumes at the failed nextLink", async () => {
  const store = new MemoryDeltaStore();
  const { fetchPage, calls } = makeFetcher(
    {
      L0: {
        value: [entity("A", 1)],
        "@odata.nextLink": "L1",
      },
      L1: {
        value: [entity("B", 1)],
        "@odata.nextLink": "L2",
      },
      L2: {
        value: [entity("C", 1)],
        "@odata.deltaLink": "D1",
      },
    },
    new Map([["L1", 1]]),
  );

  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
  });

  await assert.rejects(sync.sync(), (error) => {
    assertSyncError(error, "FETCH_FAILED");
    return true;
  });

  assert.deepEqual(calls, ["L0", "L1"]);
  assert.equal(store.getCursor("Things"), undefined);
  assert.deepEqual(store.listRecords("Things"), []);
  assert.equal(sync.resumable, true);
  assert.equal(sync.checkpoint.nextLink, "L1");
  assert.equal(sync.checkpoint.pages, 1);
  assert.equal(sync.checkpoint.changes.length, 1);

  const result = await sync.sync();

  assert.deepEqual(calls, ["L0", "L1", "L1", "L2"]);
  assert.equal(result.resumed, true);
  assert.equal(store.getCursor("Things").deltaLink, "D1");
  assert.deepEqual(
    store.listEntities("Things").map((item) => item["@odata.id"]),
    ["A", "B", "C"],
  );
  assert.equal(sync.resumable, false);
});

test("a JSON checkpoint can continue the original chain in a new process", async () => {
  const store = new MemoryDeltaStore();
  const { fetchPage, calls } = makeFetcher(
    {
      L0: { value: [entity("A", 1)], "@odata.nextLink": "L1" },
      L1: { value: [entity("B", 1)], "@odata.nextLink": "L2" },
      L2: { value: [entity("C", 1)], "@odata.deltaLink": "D1" },
    },
    new Map([["L1", 1]]),
  );

  const first = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
  });
  await assert.rejects(first.sync(), DeltaSyncError);

  const serialized = JSON.parse(JSON.stringify(first.checkpoint));
  const second = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
  });
  second.resume(serialized);

  const result = await second.sync();
  assert.deepEqual(calls, ["L0", "L1", "L1", "L2"]);
  assert.equal(result.resumed, true);
  assert.equal(store.getCursor("Things").deltaLink, "D1");
  assert.equal(store.listEntities("Things").length, 3);
});

test("a failed commit leaves the old cursor and retries without refetching", async () => {
  const inner = new MemoryDeltaStore();
  class FailOnceStore {
    constructor() {
      this.commits = 0;
      this.failNext = true;
    }
    getCursor(resource) {
      return inner.getCursor(resource);
    }
    commit(resource, changes, cursor) {
      this.commits += 1;
      if (this.failNext) {
        this.failNext = false;
        throw new Error("database unavailable");
      }
      return inner.commit(resource, changes, cursor);
    }
  }

  const store = new FailOnceStore();
  const { fetchPage, calls } = makeFetcher({
    L0: { value: [entity("A", 1)], "@odata.nextLink": "L1" },
    L1: { value: [entity("B", 1)], "@odata.deltaLink": "D1" },
  });
  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
  });

  await assert.rejects(sync.sync(), (error) => {
    assertSyncError(error, "COMMIT_FAILED");
    return true;
  });

  assert.deepEqual(calls, ["L0", "L1"]);
  assert.equal(store.commits, 1);
  assert.equal(inner.getCursor("Things"), undefined);
  assert.deepEqual(inner.listRecords("Things"), []);
  assert.equal(sync.checkpoint.phase, "commit");
  assert.equal(sync.checkpoint.pendingDeltaLink, "D1");

  const result = await sync.sync();

  assert.deepEqual(calls, ["L0", "L1"]);
  assert.equal(store.commits, 2);
  assert.equal(result.resumed, true);
  assert.equal(inner.getCursor("Things").deltaLink, "D1");
  assert.equal(inner.listEntities("Things").length, 2);
});

test("a page without a deltaLink is resumable and does not commit", async () => {
  const store = new MemoryDeltaStore();
  const routes = {
    L0: { value: [entity("A", 1)] },
  };
  const { fetchPage, calls } = makeFetcher(routes);
  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
  });

  await assert.rejects(sync.sync(), (error) => {
    assertSyncError(error, "MISSING_DELTA_LINK");
    return true;
  });
  assert.equal(store.getCursor("Things"), undefined);
  assert.equal(sync.checkpoint.nextLink, "L0");

  routes.L0 = {
    value: [entity("A", 1)],
    "@odata.deltaLink": "D1",
  };

  const result = await sync.sync();
  assert.deepEqual(calls, ["L0", "L0"]);
  assert.equal(result.stats.applied, 1);
  assert.equal(result.stats.ignored, 1);
  assert.equal(store.getCursor("Things").deltaLink, "D1");
  assert.equal(store.listEntities("Things").length, 1);
});

test("HTTP failures are resumable and Response-like success bodies are parsed", async () => {
  const store = new MemoryDeltaStore();
  const routes = {
    L0: () => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
      json: async () => ({ value: [] }),
    }),
  };
  const { fetchPage } = makeFetcher(routes);
  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
  });

  await assert.rejects(sync.sync(), (error) => {
    assertSyncError(error, "HTTP_ERROR");
    return true;
  });
  assert.equal(store.getCursor("Things"), undefined);
  assert.equal(sync.checkpoint.nextLink, "L0");

  routes.L0 = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      value: [entity("A", 1)],
      "@odata.deltaLink": "D1",
    }),
  });

  const result = await sync.sync();
  assert.equal(result.deltaLink, "D1");
  assert.equal(store.listEntities("Things").length, 1);
});

test("the persisted cursor wins over initialLink and late tombstones are rejected", async () => {
  const store = new MemoryDeltaStore();
  store.commit(
    "Things",
    [
      {
        kind: "update",
        id: "A",
        version: 8,
        entity: entity("A", 8, { Name: "generation-8" }),
      },
    ],
    { deltaLink: "D0" },
  );

  const { fetchPage, calls } = makeFetcher({
    D0: {
      value: [
        {
          "@odata.id": "A",
          version: 6,
          "@removed": { reason: "deleted" },
        },
      ],
      "@odata.deltaLink": "D1",
    },
    D1: {
      value: [
        {
          "@odata.id": "A",
          version: 9,
          "@removed": { reason: "deleted" },
        },
      ],
      "@odata.deltaLink": "D2",
    },
  });

  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "MUST-NOT-BE-USED",
  });

  const first = await sync.sync();
  assert.deepEqual(calls, ["D0"]);
  assert.equal(first.baseDeltaLink, "D0");
  assert.equal(store.getCursor("Things").deltaLink, "D1");
  assert.equal(store.getRecord("Things", "A").deleted, false);
  assert.equal(store.getRecord("Things", "A").version, 8);

  const second = await sync.sync();
  assert.deepEqual(calls, ["D0", "D1"]);
  assert.equal(second.baseDeltaLink, "D1");
  assert.equal(store.getCursor("Things").deltaLink, "D2");
  assert.equal(store.getRecord("Things", "A").deleted, true);
});

test("a repeated nextLink is detected before a round commits", async () => {
  const store = new MemoryDeltaStore();
  const { fetchPage } = makeFetcher({
    L0: { value: [entity("A", 1)], "@odata.nextLink": "L0" },
  });
  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
  });

  await assert.rejects(sync.sync(), (error) => {
    assert.ok(error instanceof DeltaSyncError);
    assert.equal(error.code, "DELTA_LOOP");
    return true;
  });
  assert.equal(store.getCursor("Things"), undefined);
  assert.deepEqual(store.listRecords("Things"), []);
  assert.equal(sync.resumable, false);
  assert.equal(sync.checkpoint, undefined);
});

test("concurrent sync calls share the same in-flight operation", async () => {
  const store = new MemoryDeltaStore();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { fetchPage } = makeFetcher({
    L0: async () => {
      await gate;
      return {
        value: [entity("A", 1)],
        "@odata.deltaLink": "D1",
      };
    },
  });
  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "L0",
  });

  const first = sync.sync();
  const second = sync.sync();
  assert.equal(first, second);
  release();

  const result = await first;
  assert.equal(result.deltaLink, "D1");
  assert.equal(store.listEntities("Things").length, 1);
});

test("the sync-level version comparator is passed to the store commit", async () => {
  const store = new MemoryDeltaStore();
  store.commit(
    "Things",
    [{ kind: "update", id: "A", version: "b", entity: entity("A", "b") }],
    { deltaLink: "D0" },
  );

  const { fetchPage } = makeFetcher({
    D0: {
      value: [entity("A", "a", { Name: "descending wins" })],
      "@odata.deltaLink": "D1",
    },
  });
  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    compareVersions: (incoming, existing) =>
      String(existing).localeCompare(String(incoming)),
  });

  const result = await sync.sync();
  assert.equal(result.stats.updated, 1);
  assert.equal(store.getRecord("Things", "A").version, "a");
  assert.equal(store.getRecord("Things", "A").entity.Name, "descending wins");
});

test("a paused round refuses to overwrite a cursor advanced by another writer", async () => {
  const store = new MemoryDeltaStore();
  store.commit("Things", [], { deltaLink: "D0" });
  const { fetchPage } = makeFetcher(
    {
      D0: { value: [entity("A", 1)], "@odata.nextLink": "L1" },
      L1: { value: [entity("B", 1)], "@odata.deltaLink": "D1" },
    },
    new Map([["L1", 1]]),
  );
  const sync = new ODataDeltaSync({
    resource: "Things",
    store,
    fetchPage,
    initialLink: "D0",
  });

  await assert.rejects(sync.sync(), DeltaSyncError);
  assert.equal(sync.checkpoint.baseDeltaLink, "D0");

  store.commit("Things", [], { deltaLink: "D9" });

  await assert.rejects(sync.sync(), (error) => {
    assert.ok(error instanceof DeltaSyncError);
    assert.equal(error.code, "CURSOR_CONFLICT");
    assert.equal(error.resumable, false);
    return true;
  });
  assert.equal(store.getCursor("Things").deltaLink, "D9");
  assert.equal(store.listEntities("Things").length, 0);
  assert.equal(sync.resumable, false);
  assert.equal(sync.checkpoint, undefined);
});
