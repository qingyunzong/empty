import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfigWatcher,
  type ConfigView,
  type Connection,
  type ConnectionSink,
  type ServerMessage,
  type SubscribeRequest,
} from "../src/config-watcher.js";

interface FakeConnection {
  conn: Connection;
  sink: ConnectionSink;
  requests: SubscribeRequest[];
  closed: boolean;
  push(message: ServerMessage): void;
  drop(): void;
}

function makeHarness(options: { maxBufferedDeltas?: number } = {}) {
  const connections: FakeConnection[] = [];
  const watcher = new ConfigWatcher({
    connect: (sink) => {
      const fake: FakeConnection = {
        conn: null as unknown as Connection,
        sink,
        requests: [],
        closed: false,
        push(message) {
          sink.onMessage(message);
        },
        drop() {
          sink.onClose();
        },
      };
      fake.conn = {
        send: (request) => {
          fake.requests.push(request);
        },
        close: () => {
          fake.closed = true;
        },
      };
      connections.push(fake);
      return fake.conn;
    },
    scheduleReconnect: (reconnect) => reconnect(),
    maxBufferedDeltas: options.maxBufferedDeltas,
  });
  const views: ConfigView[] = [];
  watcher.subscribe((view) => views.push(view));
  return { watcher, connections, views };
}

function assertMonotonic(views: ConfigView[]): void {
  for (let i = 1; i < views.length; i += 1) {
    assert.ok(
      views[i].revision > views[i - 1].revision,
      `revision must increase: ${views[i - 1].revision} -> ${views[i].revision}`,
    );
  }
}

test("snapshot then in-order deltas produce a monotonic sequence", () => {
  const { watcher, connections, views } = makeHarness();
  watcher.start();
  const c1 = connections[0];
  assert.deepEqual(c1.requests, [{ fromRevision: null }]);

  c1.push({ type: "snapshot", revision: 3, entries: { a: 1, b: 2 } });
  c1.push({ type: "delta", revision: 4, changes: [{ key: "a", value: 10 }] });
  c1.push({ type: "delta", revision: 5, changes: [{ key: "b", deleted: true }] });

  assert.deepEqual(
    views.map((v) => v.revision),
    [3, 4, 5],
  );
  assertMonotonic(views);
  assert.deepEqual(views.at(-1)!.entries, { a: 10 });
  assert.equal(watcher.revision, 5);
  assert.equal(watcher.get("a"), 10);
  assert.equal(watcher.get("b"), undefined);
});

test("revision gap is buffered and applied in order once filled", () => {
  const { watcher, connections, views } = makeHarness();
  watcher.start();
  const c1 = connections[0];

  c1.push({ type: "snapshot", revision: 3, entries: { a: 1 } });
  // Delta 5 arrives before 4: must be buffered, not emitted.
  c1.push({ type: "delta", revision: 5, changes: [{ key: "c", value: 3 }] });
  assert.deepEqual(
    views.map((v) => v.revision),
    [3],
  );
  // Delta 4 fills the gap; 4 and 5 are emitted in order.
  c1.push({ type: "delta", revision: 4, changes: [{ key: "b", value: 2 }] });
  assert.deepEqual(
    views.map((v) => v.revision),
    [3, 4, 5],
  );
  assertMonotonic(views);
  assert.deepEqual(watcher.getAll(), { a: 1, b: 2, c: 3 });
});

test("duplicate and already-applied deltas are ignored", () => {
  const { watcher, connections, views } = makeHarness();
  watcher.start();
  const c1 = connections[0];

  c1.push({ type: "snapshot", revision: 2, entries: { a: 1 } });
  c1.push({ type: "delta", revision: 3, changes: [{ key: "a", value: 2 }] });
  c1.push({ type: "delta", revision: 3, changes: [{ key: "a", value: 99 }] });
  c1.push({ type: "delta", revision: 2, changes: [{ key: "a", value: 99 }] });

  assert.deepEqual(
    views.map((v) => v.revision),
    [2, 3],
  );
  assert.equal(watcher.get("a"), 2);
});

test("reconnect resumes from the acknowledged watermark", () => {
  const { watcher, connections } = makeHarness();
  watcher.start();
  const c1 = connections[0];

  c1.push({ type: "snapshot", revision: 7, entries: { a: 1 } });
  c1.push({ type: "delta", revision: 8, changes: [{ key: "a", value: 2 }] });
  c1.drop();

  assert.equal(connections.length, 2);
  assert.deepEqual(connections[1].requests, [{ fromRevision: 8 }]);
});

test("compacted revision triggers a full rebuild from scratch", () => {
  const { watcher, connections, views } = makeHarness();
  watcher.start();
  const c1 = connections[0];

  c1.push({ type: "snapshot", revision: 5, entries: { stale: true } });
  c1.drop();
  const c2 = connections[1];
  assert.deepEqual(c2.requests, [{ fromRevision: 5 }]);

  // Server compacted revision 5 away; watcher must resubscribe from null.
  c2.push({ type: "compacted", revision: 9 });
  assert.equal(connections.length, 3);
  const c3 = connections[2];
  assert.deepEqual(c3.requests, [{ fromRevision: null }]);

  c3.push({ type: "snapshot", revision: 9, entries: { fresh: "yes" } });
  assert.deepEqual(watcher.getAll(), { fresh: "yes" });
  assert.equal(watcher.revision, 9);
  assertMonotonic(views);
  assert.deepEqual(views.at(-1)!.entries, { fresh: "yes" });
});

test("late events from an old connection cannot overwrite newer values", () => {
  const { watcher, connections, views } = makeHarness();
  watcher.start();
  const c1 = connections[0];

  c1.push({ type: "snapshot", revision: 5, entries: { key: "v5" } });
  c1.push({ type: "delta", revision: 6, changes: [{ key: "key", value: "v6" }] });
  c1.drop();

  const c2 = connections[1];
  assert.deepEqual(c2.requests, [{ fromRevision: 6 }]);
  c2.push({ type: "delta", revision: 7, changes: [{ key: "key", value: "v7-new" }] });

  // Interleaved late traffic from the dead connection must be dropped.
  c1.push({ type: "delta", revision: 7, changes: [{ key: "key", value: "v7-stale" }] });
  c1.push({ type: "delta", revision: 8, changes: [{ key: "key", value: "v8-stale" }] });
  c1.push({ type: "snapshot", revision: 9, entries: { key: "v9-stale" } });

  assert.equal(watcher.get("key"), "v7-new");
  assert.equal(watcher.revision, 7);

  c2.push({ type: "delta", revision: 8, changes: [{ key: "key", value: "v8-new" }] });
  assert.equal(watcher.get("key"), "v8-new");

  assert.deepEqual(
    views.map((v) => v.revision),
    [5, 6, 7, 8],
  );
  assertMonotonic(views);
  for (const view of views) {
    assert.notEqual(view.entries["key"], "v7-stale");
    assert.notEqual(view.entries["key"], "v8-stale");
    assert.notEqual(view.entries["key"], "v9-stale");
  }
});

test("stale snapshot on the live connection does not roll back state", () => {
  const { watcher, connections, views } = makeHarness();
  watcher.start();
  const c1 = connections[0];

  c1.push({ type: "snapshot", revision: 5, entries: { key: "v5" } });
  c1.push({ type: "delta", revision: 6, changes: [{ key: "key", value: "v6" }] });
  c1.push({ type: "snapshot", revision: 4, entries: { key: "v4-stale" } });

  assert.equal(watcher.get("key"), "v6");
  assert.equal(watcher.revision, 6);
  assertMonotonic(views);
});

test("unbounded gap forces resync from the watermark", () => {
  const { watcher, connections } = makeHarness({ maxBufferedDeltas: 2 });
  watcher.start();
  const c1 = connections[0];

  c1.push({ type: "snapshot", revision: 1, entries: {} });
  c1.push({ type: "delta", revision: 3, changes: [] });
  c1.push({ type: "delta", revision: 4, changes: [] });
  c1.push({ type: "delta", revision: 5, changes: [] });

  assert.equal(connections.length, 2);
  assert.equal(c1.closed, true);
  assert.deepEqual(connections[1].requests, [{ fromRevision: 1 }]);
});

test("deltas buffered before the first snapshot are drained after it", () => {
  const { watcher, connections, views } = makeHarness();
  watcher.start();
  const c1 = connections[0];

  c1.push({ type: "delta", revision: 3, changes: [{ key: "b", value: 2 }] });
  c1.push({ type: "delta", revision: 2, changes: [{ key: "a", value: 1 }] });
  assert.equal(views.length, 0);

  c1.push({ type: "snapshot", revision: 1, entries: { base: true } });
  assert.deepEqual(
    views.map((v) => v.revision),
    [1, 2, 3],
  );
  assertMonotonic(views);
  assert.deepEqual(watcher.getAll(), { base: true, a: 1, b: 2 });
});

test("stop prevents further reconnects", () => {
  const { watcher, connections } = makeHarness();
  watcher.start();
  connections[0].push({ type: "snapshot", revision: 1, entries: {} });
  watcher.stop();
  connections[0].drop();
  assert.equal(connections.length, 1);
});
