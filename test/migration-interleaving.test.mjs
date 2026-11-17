import test from "node:test";
import assert from "node:assert/strict";

import { SlotRouter, keySlot } from "../build/src/index.js";
import { FakeCluster, MutableTopology } from "./support/fake-cluster.mjs";

function makeCluster() {
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

  return cluster;
}

test("migration interleaving never duplicates non-idempotent work and converges", async () => {
  const cluster = makeCluster();
  const topology = new MutableTopology(cluster);
  const router = new SlotRouter({ transport: cluster, topology });

  // Pick a key known to live on the source node.
  const key = "migration-counter";
  const slot = keySlot(key);
  cluster.setSlotOwner(slot, "A");
  await router.refreshTopology();

  // t0: stable slot, one execution on A.
  assert.equal(await router.execute({ name: "INCR", args: [key] }), 1);
  assert.equal(cluster.executionCount(key), 1);

  // t1: migration starts and the key has already moved to B. The client still
  // holds the stable A route until the topology notification arrives.
  cluster.startMigration(slot, "A", "B");
  cluster.moveKey(key, "B");
  await router.refreshTopology();
  assert.equal(router.getRoute(slot).phase, "migrating");

  // A pipeline interleaves two non-idempotent commands and a read. Both write
  // attempts receive ASK and must execute exactly once, in input order, on B
  // with ASKING.
  const migrated = await router.executePipeline([
    { name: "INCR", args: [key] },
    { name: "INCR", args: [key] },
    { name: "GET", args: [key] },
  ]);

  assert.deepEqual(
    migrated.map((result) => result.value),
    [2, 3, "3"],
  );
  assert.ok(migrated.every((result) => result.ok));
  assert.deepEqual(
    migrated.map((result) => result.attempts.map((attempt) => attempt.outcome)),
    [
      ["ask", "reply"],
      ["ask", "reply"],
      ["ask", "reply"],
    ],
  );
  assert.equal(cluster.executionCount(key), 3, "each INCR should apply exactly once");
  assert.equal(router.getRoute(slot).owner, "A", "ASK must not rewrite the cache");
  assert.equal(router.getRoute(slot).phase, "migrating");

  // t2: the migration completes without a topology notification. The next
  // command hits the stale A route, receives MOVED, updates the cache, and is
  // retried once on B.
  cluster.finishMigration(slot);
  const moved = await router.executeWithTrace({ name: "INCR", args: [key] });
  assert.equal(moved.value, 4);
  assert.deepEqual(
    moved.attempts.map((attempt) => [attempt.node, attempt.outcome]),
    [
      ["A", "moved"],
      ["B", "reply"],
    ],
  );
  assert.equal(cluster.executionCount(key), 4);
  assert.equal(router.getRoute(slot).owner, "B");
  assert.equal(router.getRoute(slot).phase, "stable");

  // t3: after convergence, no redirects are emitted and each command applies
  // exactly once.
  const converged = await router.executePipeline([
    { name: "GET", args: [key] },
    { name: "INCR", args: [key] },
  ]);
  assert.equal(converged[0].value, "4");
  assert.equal(converged[1].value, 5);
  assert.ok(
    converged.every(
      (result) => result.attempts.length === 1 && result.attempts[0].node === "B",
    ),
  );
  assert.equal(cluster.executionCount(key), 5);

  // A topology refresh agrees with the locally learned MOVED route.
  await router.refreshTopology();
  assert.equal(router.getRoute(slot).owner, "B");
  assert.equal(router.getRoute(slot).phase, "stable");
  assert.equal(cluster.executionCount(key), 5);

  for (let current = 0; current < 16384; current += 1) {
    const route = router.getRoute(current);
    assert.equal(route.owner, cluster.ownerOf(current), `slot ${current} should converge`);
    assert.equal(route.phase, "stable");
  }
});

test("a lost reply during migration is surfaced without an ASK-driven retry", async () => {
  const cluster = makeCluster();
  const topology = new MutableTopology(cluster);
  const router = new SlotRouter({ transport: cluster, topology });

  const key = "migration-lost-reply";
  const slot = keySlot(key);
  cluster.setSlotOwner(slot, "A");
  await router.refreshTopology();
  assert.equal(await router.execute({ name: "INCR", args: [key] }), 1);

  cluster.startMigration(slot, "A", "B");
  cluster.moveKey(key, "B");
  await router.refreshTopology();

  cluster.injectFault(key, "unknown-after", 1);
  let failure;
  try {
    await router.execute({ name: "INCR", args: [key] });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "INDETERMINATE_EXECUTION");
  assert.equal(cluster.executionCount(key), 2);
  assert.equal(cluster.log.filter((entry) => entry.node === "B" && entry.asking).length, 1);
});
