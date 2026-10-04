import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertWindowStore } from "../src/store.js";
import type { AlertEvent, SubscriptionMessage } from "../src/types.js";

function appliedAfter(msgs: SubscriptionMessage[]): Map<string, AlertEvent> {
  const applied = new Map<string, AlertEvent>();
  for (const msg of msgs) {
    if (msg.kind === "snapshot" || msg.kind === "resync") {
      applied.clear();
      for (const item of msg.items) applied.set(item.key, item);
    } else {
      for (const change of msg.changes) {
        if (change.type === "added") applied.set(change.event.key, change.event);
        else applied.delete(change.event.key);
      }
    }
  }
  return applied;
}

test("首次快照期间更正被缓冲，发布后按序回放", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  store.upsert({ id: "a", key: "k1", time: 10 }); // v1

  const sub = store.subscribe(); // snapshot captured at v1
  // Corrections landing while the snapshot is being assembled:
  store.upsert({ id: "b", key: "k2", time: 20 }); // v2
  store.upsert({ id: "a0", key: "k1", time: 5 }); // v3, displaces a

  const msgs = sub.drain();
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].kind, "snapshot");
  assert.equal(msgs[0].version, 1);
  assert.deepEqual((msgs[0] as { items: readonly AlertEvent[] }).items.map((e) => e.id), ["a"]);

  assert.equal(msgs[1].kind, "batch");
  assert.equal(msgs[1].version, 2);
  assert.equal(msgs[2].kind, "batch");
  assert.equal(msgs[2].version, 3);

  const applied = appliedAfter(msgs);
  assert.deepEqual(
    [...applied.values()].map((e) => e.id).sort(),
    store.display().map((e) => e.id).sort(),
  );
});

test("发布后净变化不含同批撤销的显示项", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  store.upsert({ id: "base", key: "k", time: 10 }); // v1

  const sub = store.subscribe();
  sub.publishSnapshot();
  const first = sub.drain();
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "snapshot");

  store.transaction(() => {
    store.upsert({ id: "ghost", key: "k2", time: 20 });
    store.remove("ghost"); // undone inside the same batch
  }); // v2

  const msgs = sub.drain();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, "batch");
  assert.equal(msgs[0].version, 2);
  const changes = msgs[0].kind === "batch" ? msgs[0].changes : [];
  assert.deepEqual(changes, []);
  assert.ok(!JSON.stringify(msgs).includes("ghost"));
});

test("慢订阅超额转重同步，版本链不丢失", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  const sub = store.subscribe({ maxQueue: 2 });

  const first = sub.drain(); // snapshot at v0
  assert.equal(first[0].kind, "snapshot");
  assert.equal(first[0].version, 0);

  store.upsert({ id: "e1", key: "k1", time: 10 }); // v1
  store.upsert({ id: "e2", key: "k2", time: 20 }); // v2
  store.upsert({ id: "e3", key: "k3", time: 30 }); // v3 -> 3 queued batches > quota 2

  const msgs = sub.drain();
  assert.equal(msgs.length, 1);
  const resync = msgs[0];
  assert.equal(resync.kind, "resync");
  if (resync.kind !== "resync") return;
  assert.equal(resync.fromVersion, 0, "resync chains to the last delivered version");
  assert.equal(resync.version, 3, "resync covers every version up to now");
  assert.deepEqual(
    resync.items.map((e) => e.id),
    ["e1", "e2", "e3"],
  );

  // Versions continue seamlessly after the resync.
  store.upsert({ id: "e4", key: "k4", time: 40 }); // v4
  const next = sub.drain();
  assert.equal(next.length, 1);
  assert.equal(next[0].kind, "batch");
  assert.equal(next[0].version, 4);

  const applied = appliedAfter([...first, ...msgs, ...next]);
  assert.deepEqual(
    [...applied.values()].map((e) => e.id).sort(),
    store.display().map((e) => e.id).sort(),
  );
});

test("快照发布前超额则直接以当前版本重快照", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  store.upsert({ id: "a", key: "k1", time: 10 }); // v1

  const sub = store.subscribe({ maxQueue: 1 }); // snapshot pending at v1
  store.upsert({ id: "b", key: "k2", time: 20 }); // v2
  store.upsert({ id: "c", key: "k3", time: 30 }); // v3 -> overflow before publish

  const msgs = sub.drain();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, "snapshot");
  assert.equal(msgs[0].version, 3, "stale snapshot is re-captured at the current version");
  assert.deepEqual(
    (msgs[0] as { items: readonly AlertEvent[] }).items.map((e) => e.id),
    ["a", "b", "c"],
  );
});

test("关闭后不再接收消息", () => {
  const store = new AlertWindowStore({ start: 0, end: 100 });
  const sub = store.subscribe();
  sub.drain();
  sub.close();
  store.upsert({ id: "x", key: "k", time: 1 });
  assert.deepEqual(sub.drain(), []);
  assert.equal(sub.closed, true);
});
