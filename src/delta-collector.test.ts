import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Checkpoint,
  CheckpointStore,
  DeltaCollector,
  DeltaEvent,
  DeltaFetchError,
  PageFetcher,
  PageResponse,
} from "./delta-collector.js";

const INITIAL_URL = "https://dir.example/users/delta";

type Script = Map<string, PageResponse[]>;

interface Harness {
  collector: DeltaCollector;
  store: RecordingStore;
  events: DeltaEvent[];
  requestedUrls: string[];
  respond(url: string, ...responses: PageResponse[]): void;
}

class RecordingStore implements CheckpointStore {
  readonly saves: Checkpoint[] = [];
  private current: Checkpoint | null = null;

  async load(): Promise<Checkpoint | null> {
    return this.current ? structuredClone(this.current) : null;
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    this.current = structuredClone(checkpoint);
    this.saves.push(structuredClone(checkpoint));
  }

  get latest(): Checkpoint | null {
    return this.current ? structuredClone(this.current) : null;
  }
}

function ok(body: unknown): PageResponse {
  return { status: 200, body };
}

function gone(): PageResponse {
  return { status: 410 };
}

function makeHarness(): Harness {
  const script: Script = new Map();
  const requestedUrls: string[] = [];
  const events: DeltaEvent[] = [];
  const store = new RecordingStore();

  const fetcher: PageFetcher = async (url) => {
    requestedUrls.push(url);
    const queue = script.get(url);
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected request: ${url}`);
    }
    return queue.shift() as PageResponse;
  };

  const collector = new DeltaCollector({
    initialUrl: INITIAL_URL,
    fetcher,
    store,
    onEvent: (event) => events.push(event),
  });

  return {
    collector,
    store,
    events,
    requestedUrls,
    respond(url, ...responses) {
      const queue = script.get(url) ?? [];
      queue.push(...responses);
      script.set(url, queue);
    },
  };
}

test("walks nextLink pages and commits the deltaLink only after the final page", async () => {
  const h = makeHarness();
  h.respond(
    INITIAL_URL,
    ok({
      value: [{ id: "u1", displayName: "Ada" }],
      "@odata.nextLink": "https://dir.example/users/delta?$skiptoken=p2",
    }),
  );
  h.respond(
    "https://dir.example/users/delta?$skiptoken=p2",
    ok({
      value: [{ id: "u2", displayName: "Grace" }],
      "@odata.deltaLink": "https://dir.example/users/delta?$deltatoken=g1",
    }),
  );

  const result = await h.collector.run();

  assert.deepEqual(result, {
    status: "committed",
    generation: 2,
    deltaLink: "https://dir.example/users/delta?$deltatoken=g1",
  });
  assert.deepEqual(h.requestedUrls, [
    INITIAL_URL,
    "https://dir.example/users/delta?$skiptoken=p2",
  ]);

  // While paging, only the pending nextLink is persisted — never the deltaLink.
  assert.equal(h.store.saves.length, 2);
  assert.equal(
    h.store.saves[0].pendingNextLink,
    "https://dir.example/users/delta?$skiptoken=p2",
  );
  assert.equal(h.store.saves[0].committedDeltaLink, null);
  assert.equal(h.store.saves[1].pendingNextLink, null);
  assert.equal(
    h.store.saves[1].committedDeltaLink,
    "https://dir.example/users/delta?$deltatoken=g1",
  );

  assert.deepEqual([...h.collector.snapshot.keys()], ["u1", "u2"]);
  assert.deepEqual(
    h.events.map((e) => e.type),
    ["upsert", "upsert", "commit"],
  );
});

test("distinguishes removed reasons deleted and changed", async () => {
  const h = makeHarness();
  h.collector.snapshot.set("gone", { id: "gone" });
  h.collector.snapshot.set("moved", { id: "moved" });
  h.respond(
    INITIAL_URL,
    ok({
      value: [
        { id: "gone", "@removed": { reason: "deleted" } },
        { id: "moved", "@removed": { reason: "changed" } },
        { id: "kept", displayName: "Lin" },
      ],
      "@odata.deltaLink": "https://dir.example/users/delta?$deltatoken=g1",
    }),
  );

  await h.collector.run();

  const removed = h.events.flatMap((e) => (e.type === "removed" ? [e] : []));
  assert.deepEqual(
    removed.map((e) => [e.change.id, e.change.reason]),
    [
      ["gone", "deleted"],
      ["moved", "changed"],
    ],
  );
  assert.deepEqual([...h.collector.snapshot.keys()], ["kept"]);
});

test("coalesces multiple changes to the same entity within one generation", async () => {
  const h = makeHarness();
  h.respond(
    INITIAL_URL,
    ok({
      value: [{ id: "u1", displayName: "v1" }],
      "@odata.nextLink": "https://dir.example/users/delta?$skiptoken=p2",
    }),
  );
  h.respond(
    "https://dir.example/users/delta?$skiptoken=p2",
    ok({
      value: [
        { id: "u1", displayName: "v2" },
        { id: "u2", displayName: "new" },
      ],
      "@odata.nextLink": "https://dir.example/users/delta?$skiptoken=p3",
    }),
  );
  h.respond(
    "https://dir.example/users/delta?$skiptoken=p3",
    ok({
      value: [{ id: "u1", "@removed": { reason: "deleted" } }],
      "@odata.deltaLink": "https://dir.example/users/delta?$deltatoken=g1",
    }),
  );

  await h.collector.run();

  // u1 changed three times within the generation; the last change (removal) wins.
  const u1Events = h.events.flatMap((e) =>
    (e.type === "upsert" || e.type === "removed") && e.change.id === "u1"
      ? [e]
      : [],
  );
  assert.equal(u1Events.length, 1);
  assert.equal(u1Events[0].type, "removed");
  assert.deepEqual([...h.collector.snapshot.keys()], ["u2"]);
});

test("a cancelled run resumes from the original pending nextLink", async () => {
  const page2 = "https://dir.example/users/delta?$skiptoken=p2";

  const controller = new AbortController();
  const scripted = new Map<string, PageResponse[]>([
    [
      INITIAL_URL,
      [
        ok({
          value: [{ id: "u1", displayName: "Ada" }],
          "@odata.nextLink": page2,
        }),
      ],
    ],
  ]);
  const fetcher: PageFetcher = async (url, signal) => {
    if (url === page2) {
      if (!controller.signal.aborted) {
        controller.abort();
        assert.ok(signal.aborted);
        throw new Error("aborted");
      }
    }
    const queue = scripted.get(url);
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected request: ${url}`);
    }
    return queue.shift() as PageResponse;
  };

  const store = new RecordingStore();
  const collector = new DeltaCollector({
    initialUrl: INITIAL_URL,
    fetcher,
    store,
  });

  const first = await collector.run({ signal: controller.signal });
  assert.equal(first.status, "cancelled");
  assert.equal(store.latest?.pendingNextLink, page2);
  assert.equal(store.latest?.committedDeltaLink, null);
  assert.deepEqual(store.latest?.pendingChanges, [
    { id: "u1", kind: "upsert", entity: { id: "u1", displayName: "Ada" } },
  ]);

  // Resume: the walk continues along the original nextLink, keeping the
  // changes buffered before the cancellation.
  scripted.set(page2, [
    ok({
      value: [{ id: "u2", displayName: "Grace" }],
      "@odata.deltaLink": "https://dir.example/users/delta?$deltatoken=g1",
    }),
  ]);
  const second = await collector.run();
  assert.equal(second.status, "committed");
  assert.deepEqual([...collector.snapshot.keys()], ["u1", "u2"]);
  assert.equal(
    store.latest?.committedDeltaLink,
    "https://dir.example/users/delta?$deltatoken=g1",
  );
  assert.equal(store.latest?.pendingNextLink, null);
});

test("410 mid-generation starts a full new generation without polluting the snapshot", async () => {
  const h = makeHarness();
  // Old committed state: u-old lives in the snapshot, u-deleted was removed.
  h.collector.snapshot.set("u-old", { id: "u-old", displayName: "Old" });

  const page2 = "https://dir.example/users/delta?$skiptoken=p2";
  h.respond(
    INITIAL_URL,
    ok({
      value: [
        { id: "u-stale", displayName: "Stale" },
        { id: "u-old", "@removed": { reason: "deleted" } },
      ],
      "@odata.nextLink": page2,
    }),
  );
  h.respond(page2, gone());
  h.respond(
    INITIAL_URL,
    ok({
      value: [
        { id: "u-new", displayName: "Fresh" },
        { id: "u-old", displayName: "Old is back" },
      ],
      "@odata.deltaLink": "https://dir.example/users/delta?$deltatoken=full1",
    }),
  );

  const result = await h.collector.run();

  assert.equal(result.status, "committed");
  assert.deepEqual(h.events.map((e) => e.type), [
    "reset",
    "upsert",
    "upsert",
    "commit",
  ]);
  // The snapshot contains exactly the new full generation: no stale pending
  // changes and no leftover removal records from the abandoned generation.
  assert.deepEqual(
    [...h.collector.snapshot.values()].map((e) => e.id),
    ["u-new", "u-old"],
  );
  const committed = h.store.latest;
  assert.equal(
    committed?.committedDeltaLink,
    "https://dir.example/users/delta?$deltatoken=full1",
  );
  assert.equal(committed?.pendingNextLink, null);
  assert.deepEqual(committed?.pendingChanges, []);
});

test("410 on the committed deltaLink triggers a full resync of the next run", async () => {
  const h = makeHarness();
  h.respond(
    INITIAL_URL,
    ok({
      value: [{ id: "u1", displayName: "Ada" }],
      "@odata.deltaLink": "https://dir.example/users/delta?$deltatoken=g1",
    }),
  );
  await h.collector.run();
  assert.deepEqual([...h.collector.snapshot.keys()], ["u1"]);

  // Server invalidates the delta token.
  h.respond("https://dir.example/users/delta?$deltatoken=g1", gone());
  h.respond(
    INITIAL_URL,
    ok({
      value: [{ id: "u2", displayName: "Grace" }],
      "@odata.deltaLink": "https://dir.example/users/delta?$deltatoken=g2",
    }),
  );

  const result = await h.collector.run();

  assert.equal(result.status, "committed");
  assert.deepEqual(
    h.requestedUrls,
    [
      INITIAL_URL,
      "https://dir.example/users/delta?$deltatoken=g1",
      INITIAL_URL,
    ],
  );
  // Full resync replaces the snapshot wholesale.
  assert.deepEqual([...h.collector.snapshot.keys()], ["u2"]);
  assert.equal(
    h.store.latest?.committedDeltaLink,
    "https://dir.example/users/delta?$deltatoken=g2",
  );
});

test("non-2xx responses other than 410 raise DeltaFetchError", async () => {
  const h = makeHarness();
  h.respond(INITIAL_URL, { status: 500 });

  await assert.rejects(h.collector.run(), DeltaFetchError);
  // Nothing is committed or left pending.
  assert.equal(h.store.latest, null);
});
