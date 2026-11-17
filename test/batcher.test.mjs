import assert from "node:assert/strict";
import test from "node:test";

import {
  BatchScheduler,
  RequestCancelledError,
  RequestTimeoutError,
  VirtualClock,
  areBatchRequestsCompatible,
} from "../.test-dist/index.js";

function collectHandler() {
  const batches = [];
  const handler = (batch) => {
    batches.push(batch);
    return batch.requests.map((request) => request.id);
  };
  return { batches, handler };
}

test("partitions cohorts by model version and input shape", async () => {
  const clock = new VirtualClock();
  const { batches, handler } = collectHandler();
  const scheduler = new BatchScheduler({
    clock,
    maxBatchSize: 3,
    maxWaitMs: 100,
    handler,
  });

  const promises = [
    scheduler.submit({
      id: "a",
      modelVersion: "v1",
      inputShape: [1, 224, 224, 3],
      deadline: 1_000,
    }),
    scheduler.submit({
      id: "b",
      modelVersion: "v2",
      inputShape: [1, 224, 224, 3],
      deadline: 1_000,
    }),
    scheduler.submit({
      id: "c",
      modelVersion: "v1",
      inputShape: [1, 128, 128, 3],
      deadline: 1_000,
    }),
    scheduler.submit({
      id: "d",
      modelVersion: "v1",
      inputShape: [1, 224, 224, 3],
      deadline: 1_000,
    }),
    scheduler.submit({
      id: "e",
      modelVersion: "v1",
      inputShape: [1, 224, 224, 3],
      deadline: 1_000,
    }),
  ];

  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].requests.map((request) => request.id),
    ["a", "d", "e"],
  );
  assert.equal(batches[0].trigger, "batch-full");

  clock.advanceBy(100);
  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.slice(1).map((batch) => batch.requests.map((request) => request.id)),
    [["b"], ["c"]],
  );

  assert.deepEqual(await Promise.all(promises), [
    "a",
    "b",
    "c",
    "d",
    "e",
  ]);
  assert.equal(scheduler.pendingRequestCount, 0);
});

test("flushes a partial batch at the wait cap and earlier at a deadline", async () => {
  const clock = new VirtualClock(500);
  const { batches, handler } = collectHandler();
  const scheduler = new BatchScheduler({
    clock,
    maxBatchSize: 8,
    maxWaitMs: 20,
    handler,
  });

  const waited = scheduler.submit({
    id: "wait",
    modelVersion: 7,
    inputShape: "tokens",
    deadline: 900,
  });
  clock.advanceBy(19);
  assert.equal(batches.length, 0);
  clock.advanceBy(1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].dispatchedAt, 520);
  assert.equal(batches[0].trigger, "wait-expired");
  assert.deepEqual(await waited, "wait");

  const urgent = scheduler.submit({
    id: "urgent",
    modelVersion: 7,
    inputShape: "tokens",
    deadline: 529,
  });
  clock.advanceBy(8);
  assert.equal(batches.length, 1);
  clock.advanceBy(1);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].dispatchedAt, 529);
  assert.equal(batches[1].trigger, "deadline");
  assert.deepEqual(await urgent, "urgent");
});

test("rejects requests that are already late instead of dispatching them", async () => {
  const clock = new VirtualClock(100);
  const { batches, handler } = collectHandler();
  const scheduler = new BatchScheduler({
    clock,
    maxBatchSize: 2,
    maxWaitMs: 50,
    handler,
  });

  const late = scheduler.submit({
    id: "late",
    modelVersion: "v1",
    inputShape: [4],
    deadline: 99,
  });

  await assert.rejects(
    late,
    (error) =>
      error instanceof RequestTimeoutError &&
      error.requestId === "late" &&
      error.deadline === 99 &&
      error.timedOutAt === 100,
  );
  assert.equal(batches.length, 0);
  assert.equal(scheduler.pendingRequestCount, 0);
  assert.equal(scheduler.stats.timedOutRequests, 1);

  const onTime = scheduler.submit({
    id: "on-time",
    modelVersion: "v1",
    inputShape: [4],
    deadline: 100,
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].dispatchedAt, 100);
  assert.deepEqual(await onTime, "on-time");
});

test("cancelled and aborted requests free batch slots", async () => {
  const clock = new VirtualClock();
  const { batches, handler } = collectHandler();
  const scheduler = new BatchScheduler({
    clock,
    maxBatchSize: 3,
    maxWaitMs: 1_000,
    handler,
  });

  const cancelled = scheduler.submit({
    id: "cancelled",
    modelVersion: "v1",
    inputShape: [2, 2],
    deadline: 1_000,
  });
  const kept = scheduler.submit({
    id: "kept",
    modelVersion: "v1",
    inputShape: [2, 2],
    deadline: 1_000,
  });

  assert.equal(scheduler.cancel("cancelled"), true);
  assert.equal(scheduler.cancel("cancelled"), false);
  await assert.rejects(cancelled, RequestCancelledError);
  assert.equal(scheduler.pendingRequestCount, 1);
  assert.equal(scheduler.stats.cancelledRequests, 1);

  const controller = new AbortController();
  const aborted = scheduler.submit({
    id: "aborted",
    modelVersion: "v1",
    inputShape: [2, 2],
    deadline: 1_000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, RequestCancelledError);

  const third = scheduler.submit({
    id: "third",
    modelVersion: "v1",
    inputShape: [2, 2],
    deadline: 1_000,
  });
  const fourth = scheduler.submit({
    id: "fourth",
    modelVersion: "v1",
    inputShape: [2, 2],
    deadline: 1_000,
  });

  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].requests.map((request) => request.id),
    ["kept", "third", "fourth"],
  );
  assert.deepEqual(await Promise.all([kept, third, fourth]), [
    "kept",
    "third",
    "fourth",
  ]);
});

test("version switch seals old work without mixing in new requests", async () => {
  const clock = new VirtualClock();
  const batches = [];
  const complete = [];
  const scheduler = new BatchScheduler({
    clock,
    maxBatchSize: 2,
    maxWaitMs: 50,
    handler: (batch) => {
      batches.push(batch);
      return new Promise((resolve) => {
        complete.push(() =>
          resolve(batch.requests.map((request) => request.id)),
        );
      });
    },
  });

  const oldOne = scheduler.submit({
    id: "old-1",
    modelVersion: "v1",
    inputShape: [1, 32],
    deadline: 200,
  });
  const oldTwo = scheduler.submit({
    id: "old-2",
    modelVersion: "v1",
    inputShape: [1, 32],
    deadline: 200,
  });
  assert.equal(batches.length, 1);
  assert.equal(scheduler.inFlightBatchCount, 1);

  scheduler.switchVersion("v2");
  const newOne = scheduler.submit({
    id: "new-1",
    modelVersion: "v2",
    inputShape: [1, 32],
    deadline: 200,
  });
  const newTwo = scheduler.submit({
    id: "new-2",
    modelVersion: "v2",
    inputShape: [1, 32],
    deadline: 200,
  });

  assert.equal(batches.length, 2);
  assert.equal(batches[0].modelVersion, "v1");
  assert.equal(batches[1].modelVersion, "v2");
  assert.deepEqual(
    batches.map((batch) => batch.requests.map((request) => request.id)),
    [["old-1", "old-2"], ["new-1", "new-2"]],
  );
  assert.equal(scheduler.inFlightBatchCount, 2);

  complete[1]();
  assert.deepEqual(await Promise.all([newOne, newTwo]), ["new-1", "new-2"]);
  assert.equal(scheduler.inFlightBatchCount, 1);
  complete[0]();
  assert.deepEqual(await Promise.all([oldOne, oldTwo]), ["old-1", "old-2"]);
  await scheduler.drain();
  assert.equal(scheduler.inFlightBatchCount, 0);
});

test("switching versions flushes queued old cohorts and never merges them", async () => {
  const clock = new VirtualClock();
  const { batches, handler } = collectHandler();
  const scheduler = new BatchScheduler({
    clock,
    maxBatchSize: 8,
    maxWaitMs: 100,
    defaultModelVersion: "v1",
    handler,
  });

  const old = scheduler.submit({
    id: "old",
    inputShape: [1, 8],
    deadline: 100,
  });
  scheduler.switchVersion("v2");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].modelVersion, "v1");
  assert.deepEqual(await old, "old");

  const next = scheduler.submit({
    id: "next",
    inputShape: [1, 8],
    deadline: 100,
  });
  scheduler.flush();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].modelVersion, "v2");
  assert.deepEqual(await next, "next");
});

test("virtual-clock stress run preserves deadlines and batch compatibility", async () => {
  const clock = new VirtualClock(1_000);
  const { batches, handler } = collectHandler();
  const scheduler = new BatchScheduler({
    clock,
    maxBatchSize: 4,
    maxWaitMs: 15,
    handler,
  });

  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  const versions = ["v1", "v2", "v3"];
  const shapes = [[1, 8], [1, 16], "tokens"];
  const pending = [];
  const submitted = [];
  const outcomes = new Map();
  const promises = [];
  let serial = 0;
  let maxDeadline = clock.now();

  for (let step = 0; step < 160; step++) {
    const now = clock.now();
    const arrivals = Math.floor(random() * 3);
    for (let index = 0; index < arrivals; index++) {
      const id = `r-${serial++}`;
      const deadline = now + 2 + Math.floor(random() * 35);
      const version = versions[Math.floor(random() * versions.length)];
      const shape = shapes[Math.floor(random() * shapes.length)];
      const record = { id, version, shape, deadline };
      submitted.push(record);
      maxDeadline = Math.max(maxDeadline, deadline);

      const controller = new AbortController();
      const promise = scheduler.submit({
        id,
        modelVersion: version,
        inputShape: shape,
        deadline,
        signal: controller.signal,
      });
      promises.push(promise);
      pending.push({ record, controller, settled: false });
      promise.then(
        (value) => {
          outcomes.set(id, { kind: "dispatched", value });
          const pendingIndex = pending.findIndex((entry) => entry.record.id === id);
          if (pendingIndex >= 0) {
            pending.splice(pendingIndex, 1);
          }
        },
        (error) => {
          outcomes.set(id, { kind: "error", error });
          const pendingIndex = pending.findIndex((entry) => entry.record.id === id);
          if (pendingIndex >= 0) {
            pending.splice(pendingIndex, 1);
          }
        },
      );
    }

    if (pending.length > 0 && random() < 0.35) {
      const index = Math.floor(random() * pending.length);
      const [entry] = pending.splice(index, 1);
      if (random() < 0.5) {
        scheduler.cancel(entry.record.id);
      } else {
        entry.controller.abort();
      }
    }

    clock.advanceBy(Math.floor(random() * 5));
  }

  clock.advanceTo(Math.max(clock.now(), maxDeadline + 1));
  await scheduler.drain();
  await Promise.allSettled(promises);

  assert.equal(scheduler.pendingRequestCount, 0);
  assert.equal(scheduler.inFlightBatchCount, 0);
  assert.equal(outcomes.size, submitted.length);

  for (const batch of batches) {
    assert.ok(batch.requests.length > 0);
    for (const request of batch.requests) {
      assert.ok(batch.dispatchedAt <= request.deadline);
      for (const peer of batch.requests) {
        assert.equal(areBatchRequestsCompatible(request, peer), true);
      }
    }
  }

  for (const request of submitted) {
    const outcome = outcomes.get(request.id);
    assert.ok(outcome, `missing outcome for ${request.id}`);
    if (outcome.kind === "dispatched") {
      const batch = batches.find((candidate) =>
        candidate.requests.some((entry) => entry.id === request.id),
      );
      assert.ok(batch, `dispatched request ${request.id} has no batch`);
      assert.ok(batch.dispatchedAt <= request.deadline);
    } else {
      assert.ok(
        outcome.error instanceof RequestCancelledError ||
          outcome.error instanceof RequestTimeoutError,
      );
    }
  }
});
