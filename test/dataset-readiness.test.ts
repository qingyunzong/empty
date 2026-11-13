import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AbortError,
  DatasetReadinessCoordinator,
  DuplicateConsumerError,
  InvalidDeclarationError,
  InvalidSignalError,
  TaskNotFoundError,
  TaskNotReadyError,
  TaskUnregisteredError,
  createDatasetReadinessCoordinator,
} from "../index.ts";

const H1 = "sha256:1111";
const H2 = "sha256:2222";
const H3 = "sha256:3333";

test("all mode requires every declared partition with an allowed schema", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "rollup",
    mode: "all",
    requirements: [
      { dataset: "orders", partitions: ["p0", "p1"], schemaHashes: [H1] },
    ],
  });

  const first = coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });

  assert.equal(first.status, "applied");
  assert.deepEqual(first.triggered, []);
  assert.equal(task.state, "waiting");
  assert.equal(task.snapshot(), undefined);

  const second = coordinator.publish({
    dataset: "orders",
    partition: "p1",
    schemaHash: H1,
    generation: 1,
  });

  assert.deepEqual(second.triggered, ["rollup"]);
  assert.deepEqual(second.transitions, [{ id: "rollup", from: "waiting", to: "ready" }]);
  assert.equal(task.state, "ready");
  assert.equal(task.triggerCount, 1);
  assert.deepEqual(
    task.snapshot()?.entries.map((entry) => entry.partition),
    ["p0", "p1"],
  );
});

test("any mode becomes ready from one satisfied requirement and keeps all valid candidates", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "report",
    mode: "any",
    requirements: [
      { dataset: "orders", partitions: ["p0"], schemaHashes: [H1] },
      { dataset: "customers", partitions: ["p0"], schemaHashes: [H2] },
    ],
  });

  coordinator.publish({
    dataset: "customers",
    partition: "p0",
    schemaHash: H2,
    generation: 7,
  });

  assert.equal(task.state, "ready");
  assert.deepEqual(
    task.snapshot()?.entries.map((entry) => entry.dataset),
    ["customers"],
  );

  const result = coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 2,
  });

  assert.deepEqual(result.triggered, []);
  assert.deepEqual(result.updated, ["report"]);
  assert.equal(task.triggerCount, 1);
  assert.deepEqual(
    task.snapshot()?.entries.map((entry) => entry.dataset),
    ["customers", "orders"],
  );
});

test("a publication outside the allowed schema set does not satisfy the consumer", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "compatible",
    requirements: [
      { dataset: "events", partitions: ["p0"], schemas: [H1, H2] },
    ],
  });

  coordinator.publish({
    dataset: "events",
    partition: "p0",
    schemaHash: H3,
    generation: 1,
  });
  assert.equal(task.state, "waiting");

  coordinator.publish({
    dataset: "events",
    partition: "p0",
    schemaHash: H2,
    generation: 2,
  });
  assert.equal(task.state, "ready");
  assert.equal(task.snapshot()?.entries[0].schemaHash, H2);
});

test("a declaration-level schema set applies when a requirement has no override", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "default-schema",
    schemaHashes: [H1],
    requirements: [{ dataset: "orders", partitions: ["p0"] }],
  });

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H2,
    generation: 1,
  });
  assert.equal(task.state, "waiting");

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 2,
  });
  assert.equal(task.state, "ready");
});

test("withdrawing a release returns an unstarted task to waiting and tombstones the generation", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "job",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  assert.equal(task.state, "ready");
  assert.equal(task.triggerCount, 1);

  const withdrawn = coordinator.withdraw({
    dataset: "orders",
    partition: "p0",
    generation: 1,
  });

  assert.equal(withdrawn.status, "applied");
  assert.deepEqual(withdrawn.transitions, [{ id: "job", from: "ready", to: "waiting" }]);
  assert.equal(task.state, "waiting");
  assert.equal(task.snapshot(), undefined);

  const replay = coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  assert.equal(replay.status, "stale");
  assert.equal(task.state, "waiting");

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 2,
  });
  assert.equal(task.state, "ready");
  assert.equal(task.triggerCount, 2);
});

test("a started task keeps its old snapshot across newer and withdrawn releases", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "runner",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  const bound = task.start();
  assert.equal(bound.entries[0].generation, 1);
  assert.equal(task.state, "started");

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 2,
  });
  coordinator.withdraw({ dataset: "orders", partition: "p0", generation: 2 });
  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H2,
    generation: 3,
  });

  assert.equal(task.state, "started");
  assert.equal(task.triggerCount, 1);
  assert.equal(task.snapshot(), bound);
  assert.equal(task.start(), bound);
  assert.equal(task.snapshot()?.entries[0].generation, 1);
});

test("duplicate and conflicting signals do not trigger or mutate state", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "consumer",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 5,
    producer: "etl-a",
  });
  assert.equal(task.triggerCount, 1);

  const duplicate = coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 5,
    producer: "etl-a",
  });
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(duplicate.triggered, []);
  assert.equal(task.triggerCount, 1);

  const wrongSchema = coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H2,
    generation: 5,
    producer: "etl-a",
  });
  assert.equal(wrongSchema.status, "conflict");
  assert.equal(task.snapshot()?.entries[0].schemaHash, H1);

  const wrongWithdraw = coordinator.withdraw({
    dataset: "orders",
    partition: "p0",
    generation: 5,
    schemaHash: H2,
  });
  assert.equal(wrongWithdraw.status, "conflict");
  assert.equal(task.state, "ready");

  coordinator.withdraw({
    dataset: "orders",
    partition: "p0",
    generation: 5,
    schemaHash: H1,
    producer: "etl-a",
  });
  const duplicateWithdraw = coordinator.withdraw({
    dataset: "orders",
    partition: "p0",
    generation: 5,
  });
  assert.equal(duplicateWithdraw.status, "duplicate");
  assert.equal(task.state, "waiting");
  assert.equal(task.triggerCount, 1);
});

test("out-of-order generations never resurrect or retract newer publications", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "ordered",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 5,
  });
  assert.equal(task.snapshot()?.entries[0].generation, 5);

  assert.equal(
    coordinator.publish({
      dataset: "orders",
      partition: "p0",
      schemaHash: H1,
      generation: 3,
    }).status,
    "stale",
  );
  assert.equal(
    coordinator.withdraw({
      dataset: "orders",
      partition: "p0",
      generation: 4,
    }).status,
    "stale",
  );
  assert.equal(task.triggerCount, 1);
  assert.equal(task.snapshot()?.entries[0].generation, 5);

  coordinator.withdraw({ dataset: "orders", partition: "p0", generation: 5 });
  assert.equal(task.state, "waiting");

  assert.equal(
    coordinator.publish({
      dataset: "orders",
      partition: "p0",
      schemaHash: H1,
      generation: 4,
    }).status,
    "stale",
  );
  assert.equal(task.state, "waiting");

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 6,
  });
  assert.equal(task.state, "ready");
  assert.equal(task.triggerCount, 2);
});

test("signals received before declaration are visible and trigger the onReady callback", () => {
  const coordinator = new DatasetReadinessCoordinator();
  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 9,
  });

  let callbackCount = 0;
  let callbackGeneration: number | undefined;
  const task = coordinator.declareConsumer("late-consumer", {
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
    onReady(snapshot) {
      callbackCount += 1;
      callbackGeneration = snapshot.entries[0].generation;
    },
  });

  assert.equal(callbackCount, 1);
  assert.equal(callbackGeneration, 9);
  assert.equal(task.state, "ready");
  assert.equal(task.triggerCount, 1);
});

test("waitForReady resolves on trigger, on already-ready, and supports abort", async () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "waiter",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  const pending = task.waitForReady();
  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  const snapshot = await pending;
  assert.equal(snapshot.entries[0].generation, 1);

  const immediate = await task.waitForReady();
  assert.equal(immediate, snapshot);

  const abortable = coordinator.declareConsumer({
    id: "abortable",
    requirements: [{ dataset: "customers", partitions: ["p0"], schemaHashes: [H1] }],
  });
  const controller = new AbortController();
  const aborted = abortable.waitForReady({ signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error: unknown) => error instanceof AbortError);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    abortable.waitForReady({ signal: alreadyAborted.signal }),
    (error: unknown) => error instanceof AbortError,
  );
});

test("unregister rejects pending waiters and allows the id to be declared again", async () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "temporary",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  const pending = task.waitForReady();
  assert.equal(task.unregister(), true);
  await assert.rejects(pending, (error: unknown) => error instanceof TaskUnregisteredError);
  assert.throws(() => task.state, (error: unknown) => error instanceof TaskNotFoundError);
  assert.equal(task.unregister(), false);

  const recreated = coordinator.declareConsumer({
    id: "temporary",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });
  assert.equal(recreated.state, "waiting");

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  assert.equal(recreated.state, "ready");
});

test("start and tryStart enforce the ready state and are idempotent", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "starter",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  assert.equal(task.tryStart(), null);
  assert.throws(() => task.start(), (error: unknown) => error instanceof TaskNotReadyError);
  assert.throws(
    () => coordinator.start("missing"),
    (error: unknown) => error instanceof TaskNotFoundError,
  );

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  const first = task.tryStart();
  assert.notEqual(first, null);
  assert.equal(task.tryStart(), first);
  assert.equal(task.start(), first);
});

test("partitionMode any accepts one matching partition and does not regress on later partitions", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "any-partition",
    requirements: [
      {
        dataset: "orders",
        partitions: ["p0", "p1"],
        partitionMode: "any",
        schemaHashes: [H1],
      },
    ],
  });

  coordinator.publish({
    dataset: "orders",
    partition: "p1",
    schemaHash: H1,
    generation: 1,
  });
  assert.equal(task.state, "ready");
  assert.deepEqual(task.snapshot()?.entries.map((entry) => entry.partition), ["p1"]);

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  assert.deepEqual(task.snapshot()?.entries.map((entry) => entry.partition), ["p0", "p1"]);
  assert.equal(task.triggerCount, 1);

  coordinator.withdraw({ dataset: "orders", partition: "p0", generation: 1 });
  assert.equal(task.state, "ready");
  assert.deepEqual(task.snapshot()?.entries.map((entry) => entry.partition), ["p1"]);
});

test("wildcard all partitions requires every live partition to use an allowed schema", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "dataset",
    requirements: [{ dataset: "events", schemaHashes: [H1] }],
  });

  coordinator.publish({
    dataset: "events",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  assert.equal(task.state, "ready");

  coordinator.publish({
    dataset: "events",
    partition: "p1",
    schemaHash: H1,
    generation: 1,
  });
  assert.equal(task.state, "ready");
  assert.equal(task.triggerCount, 1);

  coordinator.publish({
    dataset: "events",
    partition: "p2",
    schemaHash: H2,
    generation: 1,
  });
  assert.equal(task.state, "waiting");
  assert.equal(task.snapshot(), undefined);
});

test("invalid signals and declarations are rejected with typed errors", () => {
  const coordinator = createDatasetReadinessCoordinator();

  assert.throws(
    () =>
      coordinator.publish({
        dataset: "",
        partition: "p0",
        schemaHash: H1,
        generation: 1,
      }),
    (error: unknown) => error instanceof InvalidSignalError,
  );
  assert.throws(
    () =>
      coordinator.publish({
        dataset: "orders",
        partition: "p0",
        schemaHash: H1,
        generation: 1.5,
      }),
    (error: unknown) => error instanceof InvalidSignalError,
  );
  assert.throws(
    () =>
      coordinator.withdraw({
        dataset: "orders",
        partition: "p0",
        generation: -1,
      }),
    (error: unknown) => error instanceof InvalidSignalError,
  );
  assert.throws(
    () =>
      coordinator.declareConsumer({
        id: "empty",
        requirements: [],
      }),
    (error: unknown) => error instanceof InvalidDeclarationError,
  );
  assert.throws(
    () =>
      coordinator.declareConsumer({
        id: "bad-mode",
        mode: "most" as "all",
        requirements: ["orders"],
      }),
    (error: unknown) => error instanceof InvalidDeclarationError,
  );

  coordinator.declareConsumer({ id: "duplicate", requirements: ["orders"] });
  assert.throws(
    () => coordinator.declareConsumer({ id: "duplicate", requirements: ["customers"] }),
    (error: unknown) => error instanceof DuplicateConsumerError,
  );
});

test("snapshots and publications are immutable", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "immutable",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
    producer: "etl",
  });

  const snapshot = task.snapshot();
  assert.ok(snapshot !== undefined);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entries));
  assert.ok(Object.isFrozen(snapshot.entries[0]));
  assert.throws(() => {
    (snapshot.entries as unknown as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (snapshot.entries[0] as { generation: number }).generation = 99;
  }, TypeError);
});

test("registration aliases and publication inspection share the same state", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const viaRegister = coordinator.registerTask("register", { requirements: ["orders"] });
  const viaDeclare = coordinator.declareTask("declare", { requirements: ["orders"] });
  const viaConsumer = coordinator.registerConsumer("consumer", { requirements: ["orders"] });

  coordinator.publish({
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 4,
    producer: "etl",
  });

  assert.equal(viaRegister.state, "ready");
  assert.equal(viaDeclare.state, "ready");
  assert.equal(viaConsumer.state, "ready");
  assert.equal(coordinator.listTasks().length, 3);
  assert.equal(coordinator.getPublication("orders", "p0")?.generation, 4);
  assert.deepEqual(
    coordinator.listPublications("orders").map((publication) => publication.partition),
    ["p0"],
  );

  coordinator.withdraw({ dataset: "orders", partition: "p0", generation: 4 });
  assert.equal(coordinator.getPublication("orders", "p0"), undefined);
  assert.deepEqual(coordinator.listPublications("orders"), []);
});

test("the unified signal entry handles both publish and withdraw", () => {
  const coordinator = createDatasetReadinessCoordinator();
  const task = coordinator.declareConsumer({
    id: "signal-entry",
    requirements: [{ dataset: "orders", partitions: ["p0"], schemaHashes: [H1] }],
  });

  const published = coordinator.signal({
    type: "publish",
    dataset: "orders",
    partition: "p0",
    schemaHash: H1,
    generation: 1,
  });
  assert.deepEqual(published.triggered, ["signal-entry"]);

  const withdrawn = coordinator.signal({
    type: "withdraw",
    dataset: "orders",
    partition: "p0",
    generation: 1,
  });
  assert.equal(withdrawn.status, "applied");
  assert.equal(task.state, "waiting");

  assert.throws(
    () => coordinator.signal({ type: "unknown" } as never),
    (error: unknown) => error instanceof InvalidSignalError,
  );
});
