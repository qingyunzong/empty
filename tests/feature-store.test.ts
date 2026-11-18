import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FeatureStore,
  NO_DEFAULT,
  VersionNotPublishedError,
  backfillVersion,
  buildBackfillGrid,
  evaluateFeature,
  latestValue,
  resultKey,
  sumValues,
} from "../src/index.ts";
import type {
  FeatureDefinition,
  FeatureEvent,
  PointQuery,
  VersionHandle,
} from "../src/index.ts";

// Deterministic PRNG so the exhaustive sample sequence is reproducible.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface Dataset {
  v1Events: FeatureEvent[];
  v2Events: FeatureEvent[];
  v3Events: FeatureEvent[];
  entityIds: string[];
  timestamps: number[];
  v1: FeatureDefinition;
  v2: FeatureDefinition;
  v3: FeatureDefinition;
}

function buildDataset(): Dataset {
  const random = mulberry32(20261119);
  const entityIds = ["alpha", "beta", "gamma", "delta"];
  // Include boundaries, window edges and timestamps outside version validity.
  const timestamps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const makeEvents = (bias: number): FeatureEvent[] => {
    const events: FeatureEvent[] = [];
    entityIds.forEach((entityId, position) => {
      // Different event counts per entity; one entity ends up with zero events.
      const count = (position + bias) % 5;
      for (let index = 0; index < count; index += 1) {
        events.push({
          entityId,
          eventTime: 1 + Math.floor(random() * 9),
          value: Math.floor(random() * 20) - 10,
        });
      }
    });
    // Duplicate event times exercise ordering/arrival semantics.
    events.push({ entityId: "alpha", eventTime: 4, value: 77 });
    events.push({ entityId: "alpha", eventTime: 4, value: 78 });
    return events;
  };

  const v1Events = makeEvents(0);
  const v2Events = makeEvents(2);
  const v3Events = makeEvents(4);

  const v1: FeatureDefinition = {
    featureId: "billing.score",
    versionId: "v1",
    validFrom: 2,
    validTo: 9,
    window: 3,
    aggregate: latestValue,
    defaultValue: NO_DEFAULT,
  };
  const v2: FeatureDefinition = {
    ...v1,
    versionId: "v2",
    validFrom: 1,
    validTo: 10,
    window: 2,
    aggregate: sumValues,
    // Explicit falsy default: must remain distinct from `missing`.
    defaultValue: 0,
  };
  const v3: FeatureDefinition = {
    ...v2,
    versionId: "v3",
    validFrom: 3,
    validTo: 8,
    window: 4,
    defaultValue: -1,
  };

  return { v1Events, v2Events, v3Events, entityIds, timestamps, v1, v2, v3 };
}

function groupByEntity(events: readonly FeatureEvent[]): Map<string, FeatureEvent[]> {
  const grouped = new Map<string, FeatureEvent[]>();
  for (const event of events) {
    let bucket = grouped.get(event.entityId);
    if (bucket === undefined) {
      bucket = [];
      grouped.set(event.entityId, bucket);
    }
    bucket.push({ ...event });
  }
  for (const bucket of grouped.values()) {
    bucket.sort((left, right) => left.eventTime - right.eventTime);
  }
  return grouped;
}

async function publishVersion(
  store: FeatureStore,
  definition: FeatureDefinition,
  events: readonly FeatureEvent[],
  makeActive = true,
): Promise<VersionHandle> {
  const staging = store.stageVersion(definition);
  for (const [entityId, bucket] of groupByEntity(events)) {
    // Interleave per-entity backfill chunks; nothing is visible until publish.
    staging.addEvents(entityId, bucket);
  }
  return store.publish(staging, makeActive);
}

test("exhaustive grid: every online point lookup equals the offline backfill cell", async () => {
  const data = buildDataset();
  const store = new FeatureStore();
  const handles = new Map<string, VersionHandle>([
    ["v1", await publishVersion(store, data.v1, data.v1Events)],
    ["v2", await publishVersion(store, data.v2, data.v2Events)],
    ["v3", await publishVersion(store, data.v3, data.v3Events, false)],
  ]);

  const grid = buildBackfillGrid(data.entityIds, data.timestamps);
  assert.equal(grid.length, data.entityIds.length * data.timestamps.length);

  for (const versionId of ["v1", "v2", "v3"] as const) {
    const handle = handles.get(versionId)!;
    const offline = await backfillVersion(handle, grid);
    const offlineByKey = new Map(offline.map((result) => [resultKey(result), result]));

    for (const query of grid) {
      const online = await store.lookup(query, versionId);
      const expected = offlineByKey.get(resultKey(online));
      assert.ok(expected, `offline grid must contain cell ${resultKey(online)}`);
      // Deep structural equality: status and (when present) exact numeric value.
      assert.deepEqual(online, expected);
    }
  }
});

test("missing vs explicit default are structurally distinct, including a falsy default", async () => {
  const data = buildDataset();
  // Dedicated store with a guaranteed event-free entity so the empty-window
  // branch is exercised deterministically regardless of dataset randomness.
  const store = new FeatureStore();
  await publishVersion(store, data.v1, [{ entityId: "seeded", eventTime: 4, value: 1 }]);
  await publishVersion(store, data.v2, [{ entityId: "seeded", eventTime: 4, value: 1 }]);

  // Empty window + no configured default -> missing, with no `value` key.
  const v1Empty = await store.lookup({ entityId: "vacant", timestamp: 5 }, "v1");
  assert.equal(v1Empty.status, "missing");
  assert.equal("value" in v1Empty, false);

  // v2 configures an explicit default of 0 for the identical empty window.
  const v2Empty = await store.lookup({ entityId: "vacant", timestamp: 5 }, "v2");
  assert.equal(v2Empty.status, "default");
  assert.equal(v2Empty.status === "default" ? v2Empty.value : NaN, 0);
  assert.notDeepEqual(v1Empty, v2Empty);

  // A genuine computed 0 (cancelling sum) stays `present`, never `default`.
  const cancelling: FeatureEvent[] = [
    { entityId: "x", eventTime: 4, value: 5 },
    { entityId: "x", eventTime: 5, value: -5 },
  ];
  const present = await evaluateFeature(data.v2, cancelling, { entityId: "x", timestamp: 5 });
  assert.equal(present.status, "present");
  assert.equal(present.status === "present" ? present.value : NaN, 0);

  // Unknown entity behaves exactly like an empty window.
  const unknownV1 = await store.lookup({ entityId: "ghost", timestamp: 5 }, "v1");
  const unknownV2 = await store.lookup({ entityId: "ghost", timestamp: 5 }, "v2");
  assert.equal(unknownV1.status, "missing");
  assert.equal(unknownV2.status, "default");

  // Non-zero default on v3 proves the returned value is the configured one.
  await publishVersion(store, data.v3, [{ entityId: "seeded", eventTime: 4, value: 1 }], false);
  const v3Empty = await store.lookup({ entityId: "vacant", timestamp: 5 }, "v3");
  assert.equal(v3Empty.status, "default");
  assert.equal(v3Empty.status === "default" ? v3Empty.value : NaN, -1);
});

test("time travel: window cutoff, same-time ordering and validity boundaries", async () => {
  const data = buildDataset();
  const store = new FeatureStore();
  await publishVersion(store, data.v1, data.v1Events);

  // Same-timestamp events resolve in arrival order for latest-value.
  const atFour = await store.lookup({ entityId: "alpha", timestamp: 4 }, "v1");
  assert.equal(atFour.status, "present");
  assert.equal(atFour.status === "present" ? atFour.value : NaN, 78);

  // Window=3 at t=5 covers eventTimes in [3,5]; the t=2 event is excluded.
  const alphaEvents = groupByEntity(data.v1Events).get("alpha")!;
  const windowed = alphaEvents
    .filter((event) => event.eventTime >= 3 && event.eventTime <= 5)
    .map((event) => event.value);
  const atFive = await store.lookup({ entityId: "alpha", timestamp: 5 }, "v1");
  assert.equal(atFive.status === "present" ? atFive.value : NaN, windowed[windowed.length - 1]);

  // Cutoff is inclusive on both ends.
  const boundary = await evaluateFeature(
    data.v1,
    [{ entityId: "alpha", eventTime: 3, value: 31 }],
    { entityId: "alpha", timestamp: 3 },
  );
  assert.equal(boundary.status, "present");

  // Outside the version validity interval -> missing even with events/defaults.
  const before = await store.lookup({ entityId: "alpha", timestamp: 1 }, "v1");
  const after = await store.lookup({ entityId: "alpha", timestamp: 11 }, "v1");
  assert.equal(before.status, "missing");
  assert.equal(after.status, "missing");
});

test("version switch only affects new requests; in-flight requests stay pinned", async () => {
  const data = buildDataset();

  let releaseBarrier: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const parkedV1: FeatureDefinition = {
    ...data.v1,
    aggregate: async (values) => {
      await barrier;
      return latestValue(values) as number;
    },
  };

  const store = new FeatureStore();
  await publishVersion(store, parkedV1, data.v1Events); // active = v1

  const query: PointQuery = { entityId: "alpha", timestamp: 5 };
  const inFlight = store.lookup(query); // default-routes to active v1, then parks
  // Let the lookup run until it is awaiting inside the aggregator barrier.
  await Promise.resolve();
  await Promise.resolve();

  // Publish v2 actively: the switch happens while the v1 request is awaiting.
  await publishVersion(store, data.v2, data.v2Events);
  assert.equal(store.activeVersionId, "v2");

  const newRequest = await store.lookup(query);
  assert.equal(newRequest.versionId, "v2");

  releaseBarrier();
  const parkedResult = await inFlight;
  assert.equal(parkedResult.versionId, "v1");

  // The pinned result is exactly what an explicit v1 point lookup returns.
  const explicitV1 = await store.lookup(query, "v1");
  assert.deepEqual(parkedResult, explicitV1);
});

test("staged versions are unreadable: interleaved backfill never exposes partial data", async () => {
  const data = buildDataset();
  const store = new FeatureStore();
  const v1Handle = await publishVersion(store, data.v1, data.v1Events);

  const staging = store.stageVersion(data.v2);
  const grouped = groupByEntity(data.v2Events);
  const entities = [...grouped.keys()];
  staging.addEvents(entities[0]!, grouped.get(entities[0]!)!); // partial backfill

  // Explicit lookups of the unpublished version fail like an unknown version.
  await assert.rejects(
    store.lookup({ entityId: entities[0]!, timestamp: 5 }, "v2"),
    VersionNotPublishedError,
  );
  // Default-routed traffic stays on v1 while backfill is in progress.
  assert.equal(store.activeVersionId, "v1");
  const stillV1 = await store.lookup({ entityId: entities[0]!, timestamp: 5 });
  assert.equal(stillV1.versionId, "v1");

  // Concurrent v1 lookups during staging all match the offline v1 backfill.
  const grid = buildBackfillGrid(data.entityIds, data.timestamps);
  const concurrent = await Promise.all(grid.map((query) => store.lookup(query, "v1")));
  const offlineV1 = await backfillVersion(v1Handle, grid);
  assert.deepEqual(
    concurrent.map(resultKey).sort(),
    offlineV1.map(resultKey).sort(),
  );

  // Complete the backfill, then publish atomically.
  for (const entityId of entities.slice(1)) {
    staging.addEvents(entityId, grouped.get(entityId)!);
  }
  const v2Handle = store.publish(staging);

  // Post-publish lookups equal full offline v2; no cell was ever partially visible.
  const onlineV2 = await Promise.all(grid.map((query) => store.lookup(query, "v2")));
  const offlineV2 = await backfillVersion(v2Handle, grid);
  assert.deepEqual(
    onlineV2.map(resultKey).sort(),
    offlineV2.map(resultKey).sort(),
  );

  // Published materialization is immutable.
  assert.throws(() => {
    (v2Handle.eventsByEntity.get(entities[0]!) as FeatureEvent[]).push({
      entityId: "x",
      eventTime: 0,
      value: 0,
    });
  });
  assert.throws(() => {
    v2Handle.definition.window = 999;
  });
});

test("randomized interleave stress: readers only ever see complete published versions", async () => {
  const data = buildDataset();
  const random = mulberry32(424242);
  const store = new FeatureStore();
  const v1Handle = await publishVersion(store, data.v1, data.v1Events);

  const staging = store.stageVersion(data.v3);
  const entries = [...groupByEntity(data.v3Events).entries()];
  const grid = buildBackfillGrid(data.entityIds, data.timestamps);

  // Reader traffic issued from random points during the backfill must always
  // resolve: v3 is not published yet, so only v1 (explicit) is ever readable.
  const readerChecks: Promise<void>[] = [];
  for (const [entityId, bucket] of entries) {
    staging.addEvents(entityId, bucket);
    if (random() > 0.4) {
      const probe: PointQuery = {
        entityId: grid[Math.floor(random() * grid.length)]!.entityId,
        timestamp: grid[Math.floor(random() * grid.length)]!.timestamp,
      };
      readerChecks.push(
        (async () => {
          await assert.rejects(store.lookup(probe, "v3"), VersionNotPublishedError);
          const v1Result = await store.lookup(probe, "v1");
          assert.equal(v1Result.versionId, "v1");
        })(),
      );
    }
  }
  await Promise.all(readerChecks);

  const v3Handle = store.publish(staging, false);

  // Every post-publish v3 cell matches the full offline v3 computation.
  const onlineV3 = await Promise.all(grid.map((query) => store.lookup(query, "v3")));
  const offlineV3 = await backfillVersion(v3Handle, grid);
  assert.deepEqual(
    onlineV3.map(resultKey).sort(),
    offlineV3.map(resultKey).sort(),
  );

  // Publishing v3 non-actively leaves default routing on v1.
  assert.equal(store.activeVersionId, "v1");
  assert.deepEqual(store.listPublishedVersions().sort(), ["v1", "v3"]);

  // Offline/online agreement still holds for v1 after the whole interleave.
  const onlineV1 = await Promise.all(grid.map((query) => store.lookup(query, "v1")));
  const offlineV1 = await backfillVersion(v1Handle, grid);
  assert.deepEqual(
    onlineV1.map(resultKey).sort(),
    offlineV1.map(resultKey).sort(),
  );
});
