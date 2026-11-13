import assert from "node:assert/strict";
import { test } from "node:test";
import { DynamicMapState } from "../src/dynamic-map-state.js";
import {
  AggregateSnapshot,
  InvalidManifestError,
  InvalidTransitionError,
  ManifestConflictError,
  MapStateEvent,
  UnknownSubtaskError,
} from "../src/types.js";

function collect<T>(state: DynamicMapState<T>): MapStateEvent<T>[] {
  const events: MapStateEvent<T>[] = [];
  state.subscribe((event) => events.push(event));
  return events;
}

function aggregates<T>(events: MapStateEvent<T>[]): AggregateSnapshot<T>[] {
  return events
    .filter((event) => event.type === "aggregate")
    .map((event) => (event as { snapshot: AggregateSnapshot<T> }).snapshot);
}

test("applying a manifest creates pending subtasks for its items", () => {
  const state = new DynamicMapState<number>();
  const summary = state.applyManifest({ version: "v1", items: ["a", "b"] });

  assert.deepEqual(summary, {
    version: "v1",
    added: ["a", "b"],
    cancelled: [],
    detached: [],
  });
  assert.equal(state.statusOf("a"), "pending");
  assert.equal(state.statusOf("b"), "pending");
  assert.equal(state.currentVersion, "v1");
});

test("retrying the same manifest is idempotent", () => {
  const state = new DynamicMapState<number>();
  const events = collect(state);

  state.applyManifest({ version: "v1", items: ["a", "b"] });
  const again = state.applyManifest({ version: "v1", items: ["b", "a"] });

  assert.equal(again, null);
  assert.equal(state.statusOf("a"), "pending");
  const applied = events.filter((event) => event.type === "manifest-applied");
  const ignored = events.filter((event) => event.type === "manifest-ignored");
  assert.equal(applied.length, 1);
  assert.equal(ignored.length, 1);
});

test("same version with different items is rejected", () => {
  const state = new DynamicMapState<number>();
  state.applyManifest({ version: "v1", items: ["a"] });

  assert.throws(
    () => state.applyManifest({ version: "v1", items: ["a", "b"] }),
    ManifestConflictError,
  );
});

test("manifest with duplicate items is rejected", () => {
  const state = new DynamicMapState<number>();
  assert.throws(
    () => state.applyManifest({ version: "v1", items: ["a", "a"] }),
    InvalidManifestError,
  );
});

test("revision adds new subtasks and cancels ones not yet started", () => {
  const state = new DynamicMapState<number>();
  state.applyManifest({ version: "v1", items: ["a", "b", "c"] });
  state.startSubtask("b");

  const summary = state.applyManifest({ version: "v2", items: ["b", "d"] });

  assert.deepEqual(summary, {
    version: "v2",
    added: ["d"],
    cancelled: ["a", "c"],
    detached: [],
  });
  assert.equal(state.statusOf("a"), "cancelled");
  assert.equal(state.statusOf("b"), "running");
  assert.equal(state.statusOf("c"), "cancelled");
  assert.equal(state.statusOf("d"), "pending");
});

test("revision detaches running subtasks removed from the manifest", () => {
  const state = new DynamicMapState<number>();
  state.applyManifest({ version: "v1", items: ["a", "b"] });
  state.startSubtask("a");

  const summary = state.applyManifest({ version: "v2", items: ["b"] });

  assert.deepEqual(summary?.detached, ["a"]);
  assert.equal(state.statusOf("a"), "running");

  state.completeSubtask("a", 1);
  assert.equal(state.getResult("a")?.version, "v1");
});

test("succeeded results keep their version attribution across revisions", () => {
  const state = new DynamicMapState<number>();
  state.applyManifest({ version: "v1", items: ["a", "b"] });
  state.startSubtask("a");
  state.completeSubtask("a", 42);

  state.applyManifest({ version: "v2", items: ["b"] });

  const result = state.getResult("a");
  assert.equal(result?.value, 42);
  assert.equal(result?.version, "v1");
  assert.equal(state.statusOf("a"), "succeeded");
});

test("aggregate fires exactly once after the current manifest is terminal", () => {
  const state = new DynamicMapState<number>();
  const events = collect(state);
  state.applyManifest({ version: "v1", items: ["a", "b"] });

  state.startSubtask("a");
  state.completeSubtask("a", 1);
  assert.equal(aggregates(events).length, 0);

  state.startSubtask("b");
  state.completeSubtask("b", 2);
  assert.equal(aggregates(events).length, 1);

  const snapshot = aggregates(events)[0]!;
  assert.equal(snapshot.version, "v1");
  assert.deepEqual([...snapshot.results.keys()].sort(), ["a", "b"]);
  assert.equal(snapshot.results.get("a")?.version, "v1");
});

test("failures count as terminal and appear in the aggregate snapshot", () => {
  const state = new DynamicMapState<number>();
  const events = collect(state);
  state.applyManifest({ version: "v1", items: ["a", "b"] });

  state.startSubtask("a");
  state.completeSubtask("a", 1);
  state.startSubtask("b");
  state.failSubtask("b", new Error("boom"));

  const snapshots = aggregates(events);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]!.results.get("a")?.value, 1);
  assert.equal(snapshots[0]!.failures.size, 1);
});

test("cancelled pending subtasks do not block aggregation", () => {
  const state = new DynamicMapState<number>();
  const events = collect(state);
  state.applyManifest({ version: "v1", items: ["a", "b"] });
  state.startSubtask("a");

  state.applyManifest({ version: "v2", items: ["a"] });
  assert.equal(aggregates(events).length, 0);

  state.completeSubtask("a", 7);
  const snapshots = aggregates(events);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]!.version, "v2");
  assert.deepEqual([...snapshots[0]!.results.keys()], ["a"]);
});

test("a revision after aggregation opens a new epoch that aggregates once more", () => {
  const state = new DynamicMapState<number>();
  const events = collect(state);
  state.applyManifest({ version: "v1", items: ["a"] });
  state.startSubtask("a");
  state.completeSubtask("a", 1);
  assert.equal(aggregates(events).length, 1);

  state.applyManifest({ version: "v2", items: ["a", "b"] });
  state.startSubtask("b");
  state.completeSubtask("b", 2);

  const snapshots = aggregates(events);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1]!.version, "v2");
  assert.equal(snapshots[1]!.results.get("a")?.version, "v1");
  assert.equal(snapshots[1]!.results.get("b")?.version, "v2");
});

test("detached subtasks finishing late never retrigger aggregation", () => {
  const state = new DynamicMapState<number>();
  const events = collect(state);
  state.applyManifest({ version: "v1", items: ["a", "b"] });
  state.startSubtask("a");
  state.startSubtask("b");

  state.applyManifest({ version: "v2", items: ["b"] });
  state.completeSubtask("b", 2);
  assert.equal(aggregates(events).length, 1);

  state.completeSubtask("a", 1);
  assert.equal(aggregates(events).length, 1);
  assert.equal(state.getResult("a")?.version, "v1");
});

test("a cancelled subtask reappearing in a later revision is revived", () => {
  const state = new DynamicMapState<number>();
  state.applyManifest({ version: "v1", items: ["a"] });
  state.applyManifest({ version: "v2", items: [] });
  assert.equal(state.statusOf("a"), "cancelled");

  state.applyManifest({ version: "v3", items: ["a"] });
  assert.equal(state.statusOf("a"), "pending");
});

test("invalid transitions and unknown subtasks throw", () => {
  const state = new DynamicMapState<number>();
  state.applyManifest({ version: "v1", items: ["a"] });

  assert.throws(() => state.completeSubtask("a", 1), InvalidTransitionError);
  assert.throws(() => state.failSubtask("a", new Error("x")), InvalidTransitionError);
  assert.throws(() => state.statusOf("nope"), UnknownSubtaskError);
  assert.throws(() => state.startSubtask("nope"), UnknownSubtaskError);

  state.startSubtask("a");
  assert.throws(() => state.startSubtask("a"), InvalidTransitionError);
});
