import test from "node:test";
import assert from "node:assert/strict";

import {
  CrossSlotError,
  IndeterminateExecutionError,
  InvalidRedirectError,
  RedisReplyError,
  SlotRouter,
  keySlot,
} from "../build/src/index.js";
import {
  FakeCluster,
  MutableTopology,
  findKeyInRange,
} from "./support/fake-cluster.mjs";

function fixture() {
  const cluster = new FakeCluster([
    { id: "A", host: "10.0.0.1", port: 7000 },
    { id: "B", host: "10.0.0.2", port: 7000 },
    { id: "C", host: "10.0.0.3", port: 7000 },
  ]);

  for (let slot = 0; slot <= 5460; slot += 1) {
    cluster.setSlotOwner(slot, "A");
  }
  for (let slot = 5461; slot <= 10922; slot += 1) {
    cluster.setSlotOwner(slot, "B");
  }
  for (let slot = 10923; slot <= 16383; slot += 1) {
    cluster.setSlotOwner(slot, "C");
  }

  const topology = new MutableTopology(cluster);
  const router = new SlotRouter({
    transport: cluster,
    topology,
    maxTransportRetries: 2,
    maxRedirects: 4,
    maxTryAgainRetries: 2,
  });

  return {
    cluster,
    topology,
    router,
    keys: {
      A: findKeyInRange(0, 5460, "alpha"),
      B: findKeyInRange(5461, 10922, "beta"),
      C: findKeyInRange(10923, 16383, "gamma"),
    },
  };
}

test("stable slots route to their owners", async () => {
  const { cluster, router, keys } = fixture();

  for (const [owner, key] of Object.entries(keys)) {
    const result = await router.executeWithTrace({ name: "GET", args: [key] });
    assert.equal(result.node.id, owner);
    assert.equal(result.slot, keySlot(key));
    assert.equal(result.attempts.length, 1);
  }

  assert.equal(cluster.log.length, 3);
  assert.deepEqual(cluster.log.map((entry) => entry.node).sort(), ["A", "B", "C"]);
});

test("a keyless command loads the topology on first use", async () => {
  const { router } = fixture();
  assert.equal(await router.execute({ name: "PING" }), "PONG");
  assert.ok(router.slotCount > 0);
});

test("MOVED permanently updates the cache and the retry executes once", async () => {
  const { cluster, router, keys } = fixture();
  const key = keys.A;
  const slot = keySlot(key);
  await router.refreshTopology();
  assert.equal(router.getRoute(slot).owner, "A");

  // Cluster moved ownership, but the client still has the old cache entry.
  cluster.setSlotOwner(slot, "B");
  const result = await router.executeWithTrace({ name: "INCR", args: [key] });

  assert.equal(result.value, 1);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].outcome, "moved");
  assert.equal(result.attempts[0].node, "A");
  assert.equal(result.attempts[1].node, "B");
  assert.equal(router.getRoute(slot).owner, "B");
  assert.equal(router.getRoute(slot).phase, "stable");
  assert.equal(cluster.executionCount(key), 1);

  const second = await router.executeWithTrace({ name: "INCR", args: [key] });
  assert.equal(second.value, 2);
  assert.equal(second.attempts.length, 1);
  assert.equal(second.attempts[0].node, "B");
  assert.equal(cluster.executionCount(key), 2);
});

test("ASK is a one-shot ASKING hop and never rewrites the cache", async () => {
  const { cluster, router, keys } = fixture();
  const key = keys.A;
  const slot = keySlot(key);

  assert.equal(await router.execute({ name: "INCR", args: [key] }), 1);

  cluster.startMigration(slot, "A", "B");
  cluster.moveKey(key, "B");
  await router.refreshTopology();
  assert.equal(router.getRoute(slot).phase, "migrating");
  assert.equal(router.getRoute(slot).owner, "A");
  assert.equal(router.getRoute(slot).target, "B");

  const asked = await router.executeWithTrace({ name: "INCR", args: [key] });
  assert.equal(asked.value, 2);
  assert.equal(asked.attempts.length, 2);
  assert.deepEqual(
    asked.attempts.map((attempt) => [attempt.node, attempt.asking, attempt.outcome]),
    [
      ["A", false, "ask"],
      ["B", true, "reply"],
    ],
  );
  assert.equal(router.getRoute(slot).owner, "A");
  assert.equal(router.getRoute(slot).phase, "migrating");

  cluster.finishMigration(slot);
  const moved = await router.executeWithTrace({ name: "INCR", args: [key] });
  assert.equal(moved.value, 3);
  assert.deepEqual(
    moved.attempts.map((attempt) => attempt.outcome),
    ["moved", "reply"],
  );
  assert.equal(router.getRoute(slot).owner, "B");
  assert.equal(router.getRoute(slot).phase, "stable");
  assert.equal(cluster.executionCount(key), 3);
});

test("pipeline results keep input order even when nodes reply out of order", async () => {
  const { cluster, router, keys } = fixture();
  cluster.keys.set(keys.A, { key: keys.A, node: "A", value: "value-A" });
  cluster.keys.set(keys.B, { key: keys.B, node: "B", value: "value-B" });
  cluster.keys.set(keys.C, { key: keys.C, node: "C", value: "value-C" });
  cluster.setDelay(keys.A, 30);
  cluster.setDelay(keys.B, 15);
  cluster.setDelay(keys.C, 0);

  const results = await router.executePipeline([
    { name: "GET", args: [keys.A] },
    { name: "GET", args: [keys.B] },
    { name: "GET", args: [keys.C] },
    { name: "GET", args: [keys.A] },
  ]);

  assert.deepEqual(
    results.map((result) => result.index),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    results.map((result) => result.value),
    ["value-A", "value-B", "value-C", "value-A"],
  );
  assert.ok(results.every((result) => result.ok));
});

test("pipeline keeps same-node command order", async () => {
  const { cluster, router, keys } = fixture();
  cluster.setDelay(keys.A, 5);

  const results = await router.executePipeline([
    { name: "INCR", args: [keys.A] },
    { name: "GET", args: [keys.A] },
  ]);

  assert.equal(results[0].value, 1);
  assert.equal(results[1].value, "1");
  assert.equal(cluster.executionCount(keys.A), 1);
});

test("pipeline rejects cross-slot commands immediately, before I/O", async () => {
  const { cluster, router, keys } = fixture();
  const before = cluster.log.length;

  const rejected = await router.executePipeline([
    { name: "MSET", args: [keys.A, "1", keys.B, "2"] },
  ]);

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].ok, false);
  assert.ok(rejected[0].error instanceof CrossSlotError);
  assert.equal(rejected[0].attempts.length, 0);
  assert.equal(cluster.log.length, before);
  assert.equal(cluster.effects.length, 0);

  const mixed = await router.executePipeline([
    { name: "GET", args: [keys.A] },
    { name: "MSET", args: [keys.A, "1", keys.B, "2"] },
    { name: "GET", args: [keys.C] },
  ]);
  assert.equal(mixed[0].ok, true);
  assert.equal(mixed[1].ok, false);
  assert.ok(mixed[1].error instanceof CrossSlotError);
  assert.equal(mixed[2].ok, true);
  assert.equal(cluster.effects.length, 0);
});

test("execute rejects a cross-slot command before resolving a route", async () => {
  const { cluster, router, keys } = fixture();
  const before = cluster.log.length;

  await assert.rejects(
    router.execute({ name: "RENAME", args: [keys.A, keys.B] }),
    (error) => error instanceof CrossSlotError,
  );

  assert.equal(cluster.log.length, before);
  assert.equal(cluster.effects.length, 0);
});

test("an unknown-delivery error is never retried for a non-idempotent command", async () => {
  const { cluster, router, keys } = fixture();
  const key = keys.A;
  await router.refreshTopology();

  cluster.injectFault(key, "unknown-after", 1);
  await assert.rejects(
    router.executeWithTrace({ name: "INCR", args: [key] }),
    (error) => {
      assert.ok(error instanceof IndeterminateExecutionError);
      assert.equal(error.code, "INDETERMINATE_EXECUTION");
      return true;
    },
  );

  assert.equal(cluster.executionCount(key), 1);
  assert.equal(await router.execute({ name: "GET", args: [key] }), "1");
  assert.equal(cluster.executionCount(key), 1);
});

test("unknown delivery inside a pipeline does not duplicate a non-idempotent item", async () => {
  const { cluster, router, keys } = fixture();
  const key = keys.A;
  await router.refreshTopology();
  cluster.injectFault(key, "unknown-after", 1);

  const results = await router.executePipeline([
    { name: "INCR", args: [key] },
    { name: "INCR", args: [key] },
  ]);

  assert.equal(results[0].ok, false);
  assert.ok(results[0].error instanceof IndeterminateExecutionError);
  assert.equal(results[0].attempts.length, 1);
  assert.equal(results[0].attempts[0].outcome, "indeterminate");
  assert.equal(results[1].ok, true);
  assert.equal(results[1].value, 2);
  assert.equal(cluster.executionCount(key), 2);
});

test("only provably-not-sent transport failures are retried", async () => {
  const { cluster, router, keys } = fixture();
  const key = keys.A;
  await router.refreshTopology();

  cluster.injectFault(key, "not-sent-before", 1);
  const result = await router.executeWithTrace({ name: "INCR", args: [key] });

  assert.equal(result.value, 1);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.outcome),
    ["not-sent", "reply"],
  );
  assert.equal(cluster.executionCount(key), 1);
});

test("TRYAGAIN (a server-confirmed non-execution) may refresh and retry", async () => {
  const { cluster, router, keys } = fixture();
  const key = keys.A;
  await router.refreshTopology();

  cluster.injectFault(key, "server-error-before", 1);
  const result = await router.executeWithTrace({ name: "INCR", args: [key] });

  assert.equal(result.value, 1);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.outcome),
    ["try-again", "reply"],
  );
  assert.equal(cluster.executionCount(key), 1);
});

test("a native transport batch is used and results stay ordered", async () => {
  const { cluster, keys } = fixture();
  const batchCalls = [];
  const transport = {
    execute(node, command, context) {
      return cluster.execute(node, command, context);
    },
    async executeBatch(node, entries) {
      batchCalls.push({ node: node.id, count: entries.length });
      const results = [];
      for (const entry of entries) {
        try {
          results.push({
            ok: true,
            value: await cluster.execute(node, entry.command, { asking: entry.asking }),
          });
        } catch (error) {
          results.push({ ok: false, error });
        }
      }
      return results;
    },
  };
  const topology = new MutableTopology(cluster);
  const router = new SlotRouter({ transport, topology });

  const results = await router.executePipeline([
    { name: "INCR", args: [keys.A] },
    { name: "GET", args: [keys.A] },
    { name: "INCR", args: [keys.B] },
  ]);

  assert.deepEqual(
    results.map((result) => result.value),
    [1, "1", 1],
  );
  assert.deepEqual(batchCalls, [
    { node: "A", count: 2 },
    { node: "B", count: 1 },
  ]);
});

test("a refresh started before MOVED cannot overwrite the newer route", async () => {
  const { cluster, topology, router, keys } = fixture();
  const key = keys.A;
  const slot = keySlot(key);
  router.applyTopology(cluster.snapshot(1));

  const release = topology.hold();
  const refresh = router.refreshTopology();

  // The refresh has captured a snapshot where A still owns the slot.
  cluster.setSlotOwner(slot, "B");
  const moved = await router.executeWithTrace({ name: "INCR", args: [key] });
  assert.equal(moved.value, 1);
  assert.equal(router.getRoute(slot).owner, "B");

  release();
  await refresh;
  assert.equal(router.getRoute(slot).owner, "B");

  await router.refreshTopology();
  assert.equal(router.getRoute(slot).owner, "B");
  assert.equal(cluster.executionCount(key), 1);
});

test("a malformed redirect fails only its pipeline item", async () => {
  const { cluster, keys } = fixture();
  const transport = {
    async execute(node, command, context) {
      if (command.key === keys.A) {
        throw new RedisReplyError("MOVED 999999 10.0.0.9:7000");
      }
      return cluster.execute(node, command, context);
    },
  };
  const topology = new MutableTopology(cluster);
  const router = new SlotRouter({ transport, topology });

  const results = await router.executePipeline([
    { name: "GET", args: [keys.A] },
    { name: "GET", args: [keys.B] },
  ]);

  assert.equal(results[0].ok, false);
  assert.ok(results[0].error instanceof InvalidRedirectError);
  assert.equal(results[0].attempts.length, 1);
  assert.equal(results[1].ok, true);
});
