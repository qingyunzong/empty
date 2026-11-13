import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CheckpointConflictError,
  ControllablePartitionStore,
  EpochReceiver,
  InMemoryPartitionStore,
  LeaseLostError,
  ManualClock,
  OwnershipConflictError,
  PartitionOwnership,
  PreemptedError,
  TelemetryCollector,
} from "../src/index.ts";
import type { Batch, OwnershipRecord } from "../src/index.ts";

function fixture(options: { leaseDurationMs?: number; clock?: ManualClock } = {}) {
  const clock = options.clock ?? new ManualClock(1_000);
  const store = new ControllablePartitionStore({
    now: () => clock.read(),
  });
  return { clock, store };
}

function owner(
  store: InMemoryPartitionStore,
  clock: ManualClock,
  workerId: string,
  options: { leaseDurationMs?: number } = {},
): PartitionOwnership {
  return new PartitionOwnership({
    store,
    workerId,
    partitionId: "orders-0",
    leaseDurationMs: options.leaseDurationMs ?? 300,
    now: () => clock.read(),
  });
}

async function batchFrom(
  receiver: EpochReceiver,
  sequenceNumber: number,
): Promise<Batch> {
  receiver.enqueue({ sequenceNumber, events: [{ sequenceNumber }] });
  const batch = await receiver.receiveBatch();
  if (batch === undefined) {
    throw new Error("receiver returned no batch");
  }
  return batch;
}

describe("partition ownership", () => {
  test("acquires, renews without rotating the ETag, and checkpoints", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a", { leaseDurationMs: 100 });

    const lease = await a.acquire();
    assert.equal(lease.epoch, 1);
    assert.equal(a.epoch, 1);
    assert.equal(a.etag, lease.etag);
    assert.equal(a.checkpoint, -1);

    const receiver = a.createEpochReceiver();
    const first = await batchFrom(receiver, 4);
    assert.equal(first.epoch, 1);
    assert.equal(first.etag, lease.etag);

    clock.advance(40);
    assert.equal(await a.renew(), true);
    assert.equal(a.etag, lease.etag);

    const checkpoint = await a.commit(first);
    assert.equal(checkpoint.sequenceNumber, 4);
    assert.equal(checkpoint.epoch, 1);
    assert.equal(a.watermark, 4);

    const stored = await store.getCheckpoint("orders-0");
    assert.deepEqual(stored, checkpoint);

    // A successful renewal keeps the epoch token valid for in-flight batches.
    const second = await batchFrom(receiver, 5);
    assert.equal((await a.commit(second)).sequenceNumber, 5);
  });

  test("one free partition has exactly one winner across both admission orders", async () => {
    for (const firstWorker of ["worker-a", "worker-b"] as const) {
      const { clock, store } = fixture();
      const a = owner(store, clock, "worker-a");
      const b = owner(store, clock, "worker-b");

      const [first, second] =
        firstWorker === "worker-a"
          ? await Promise.all([a.tryAcquire(), b.tryAcquire()])
          : await Promise.all([b.tryAcquire(), a.tryAcquire()]);

      const winner = first;
      const loser = second;
      const winnerWorker = firstWorker;
      const loserWorker =
        firstWorker === "worker-a" ? "worker-b" : "worker-a";

      assert.equal(winner.acquired, true);
      assert.equal(winner.record?.ownerId, winnerWorker);
      assert.equal(winner.record?.epoch, 1);
      assert.equal(loser.acquired, false);
      assert.equal(loser.reason, "lease-active");
      assert.equal(loser.previous?.ownerId, winnerWorker);

      const records: OwnershipRecord[] = store.snapshot().ownership;
      assert.equal(records.length, 1);
      assert.equal(records[0]?.ownerId, winnerWorker);
      assert.equal(loserWorker === winnerWorker, false);
    }
  });

  test("preemption rejects the old epoch's in-flight batch and freezes its watermark", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a");
    const b = owner(store, clock, "worker-b");

    const leaseA = await a.acquire();
    const receiverA = a.createEpochReceiver();
    const inFlight = await batchFrom(receiverA, 10);

    let handlerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const processing = a.processBatch(inFlight, async () => {
      handlerEntered();
      await handlerGate;
    });
    await entered;

    // B wins while A is still inside its batch handler.
    const leaseB = await b.acquire({ preempt: true });
    assert.equal(leaseB.epoch, 2);
    assert.equal(leaseB.preempted, true);
    assert.notEqual(leaseB.etag, leaseA.etag);

    releaseHandler();
    const result = await processing;
    assert.equal(result.processed, true);
    assert.equal(result.committed, false);
    assert.equal(result.reason, "preempted");

    assert.equal(await store.getCheckpoint("orders-0"), undefined);
    assert.equal(a.checkpoint, -1);
    await assert.rejects(
      () => a.commit(inFlight),
      (error: unknown) =>
        error instanceof PreemptedError &&
        error.code === "stale-epoch" &&
        /superseded|epoch/i.test(error.message),
    );

    const receiverB = b.createEpochReceiver();
    const newEpochBatch = await batchFrom(receiverB, 11);
    assert.equal(newEpochBatch.epoch, 2);
    assert.equal(newEpochBatch.etag, leaseB.etag);
    assert.equal((await b.commit(newEpochBatch)).sequenceNumber, 11);
    assert.equal((await store.getCheckpoint("orders-0"))?.epoch, 2);

    // A can never move the watermark again after the takeover.
    const laterOldBatch = { ...inFlight, sequenceNumber: 12 };
    await assert.rejects(
      () => a.commit(laterOldBatch),
      (error: unknown) => error instanceof PreemptedError,
    );
    assert.equal((await store.getCheckpoint("orders-0"))?.sequenceNumber, 11);
  });

  test("an expired lease is won by exactly one of renew and takeover", async () => {
    for (const order of ["renew-first", "takeover-first"] as const) {
      const { clock, store } = fixture();
      const a = owner(store, clock, "worker-a", { leaseDurationMs: 10 });
      const b = owner(store, clock, "worker-b", { leaseDurationMs: 10 });

      const leaseA = await a.acquire();
      clock.advance(20);

      let renewed: boolean;
      let takeover: Awaited<ReturnType<PartitionOwnership["tryAcquire"]>>;
      if (order === "renew-first") {
        renewed = await a.renew();
        takeover = await b.tryAcquire();
      } else {
        takeover = await b.tryAcquire();
        renewed = await a.renew();
      }

      if (order === "renew-first") {
        assert.equal(renewed, true);
        assert.equal(takeover.acquired, false);
        assert.equal(takeover.reason, "lease-active");
        assert.equal((await store.getOwnership("orders-0"))?.epoch, 1);
      } else {
        assert.equal(takeover.acquired, true);
        assert.equal(takeover.record?.epoch, 2);
        assert.equal(renewed, false);
        assert.equal(a.preempted, true);
        assert.equal((await store.getOwnership("orders-0"))?.ownerId, "worker-b");
      }
      assert.notEqual(leaseA.etag, "");
    }
  });

  test("a failed renewal allows the current batch to finish but never advances the checkpoint", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a", { leaseDurationMs: 100 });
    const lease = await a.acquire();
    const receiver = a.createEpochReceiver();

    const beforeFailure = await batchFrom(receiver, 20);
    assert.equal((await a.commit(beforeFailure)).sequenceNumber, 20);

    store.failNextRenew(new Error("lease service unavailable"));
    assert.equal(await a.renew(), false);
    assert.equal(a.leaseLost, true);
    assert.equal(a.stopped, true);
    assert.equal(a.checkpoint, 20);

    const inFlight = await batchFrom(receiver, 21);
    let handlerCalls = 0;
    const result = await a.processBatch(inFlight, async () => {
      handlerCalls += 1;
    });
    assert.equal(handlerCalls, 1);
    assert.equal(result.processed, true);
    assert.equal(result.committed, false);
    assert.equal(result.reason, "lease-lost");
    assert.equal(a.checkpoint, 20);
    assert.equal((await store.getCheckpoint("orders-0"))?.sequenceNumber, 20);

    await assert.rejects(
      () => a.commit(inFlight),
      (error: unknown) => error instanceof LeaseLostError,
    );

    // Only the current batch boundary is honored; a following batch is refused.
    const next = await batchFrom(receiver, 22);
    let nextHandlerCalls = 0;
    const refused = await a.processBatch(next, async () => {
      nextHandlerCalls += 1;
    });
    assert.equal(nextHandlerCalls, 0);
    assert.equal(refused.processed, false);
    assert.equal(refused.reason, "lease-lost");
    assert.equal((await store.getCheckpoint("orders-0"))?.sequenceNumber, 20);
    assert.notEqual(lease.epoch, undefined);
  });

  test("renewal failure during a batch is detected after the handler and before commit", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a", { leaseDurationMs: 100 });
    await a.acquire();
    const receiver = a.createEpochReceiver();
    const inFlight = await batchFrom(receiver, 31);

    store.failNextRenew(new Error("renew timeout"));
    const result = await a.processBatch(inFlight, async () => {
      assert.equal(await a.renew(), false);
    });
    assert.equal(result.processed, true);
    assert.equal(result.committed, false);
    assert.equal(result.reason, "lease-lost");
    assert.equal(await store.getCheckpoint("orders-0"), undefined);
  });

  test("checkpoint CAS prevents a stale writer from moving the watermark", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a");
    const lease = await a.acquire();
    const receiver = a.createEpochReceiver();
    const first = await batchFrom(receiver, 40);
    await a.commit(first);

    // Simulate a concurrent checkpoint writer that still has the same
    // ownership token, but writes a newer checkpoint ETag.
    const external = await store.commitCheckpoint({
      partitionId: "orders-0",
      ownerId: "worker-a",
      epoch: lease.epoch,
      ownershipEtag: lease.etag,
      sequenceNumber: 45,
      expectedCheckpointEtag: undefined,
      now: clock.read(),
    });
    assert.equal(external.committed, true);

    const stale = await batchFrom(receiver, 41);
    await assert.rejects(
      () => a.commit(stale),
      (error: unknown) =>
        error instanceof CheckpointConflictError &&
        error.code === "checkpoint-conflict",
    );
    assert.equal((await store.getCheckpoint("orders-0"))?.sequenceNumber, 45);
    assert.equal(a.checkpoint, 40);
  });

  test("collector stops before receiving the next batch after renewal fails", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a", { leaseDurationMs: 100 });
    await a.acquire();
    const receiver = a.createEpochReceiver();
    receiver.enqueue({ sequenceNumber: 50 });
    receiver.enqueue({ sequenceNumber: 51 });

    const collector = new TelemetryCollector({
      ownership: a,
      receiver,
      autoRenew: true,
      renewLeadMs: 50,
      now: () => clock.read(),
      process: async () => {},
    });

    store.failNextRenew(new Error("renew unavailable"));
    clock.advance(60);

    const result = await collector.run();
    assert.equal(result.batchesReceived, 0);
    assert.equal(result.batchesProcessed, 0);
    assert.equal(result.batchesCommitted, 0);
    assert.equal(result.stopReason, "lease-lost");
    assert.equal(a.checkpoint, -1);
  });

  test("collector commits completed batches and stops at a mid-run lease loss", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a", { leaseDurationMs: 100 });
    await a.acquire();
    const receiver = a.createEpochReceiver();
    receiver.enqueue({ sequenceNumber: 60 });
    receiver.enqueue({ sequenceNumber: 61 });

    const processed: number[] = [];
    const collector = new TelemetryCollector({
      ownership: a,
      receiver,
      now: () => clock.read(),
      process: async (batch) => {
        processed.push(batch.sequenceNumber as number);
        if (batch.sequenceNumber === 60) {
          store.failNextRenew(new Error("lease vanished"));
          assert.equal(await a.renew(), false);
        }
      },
    });

    const result = await collector.run();
    assert.deepEqual(processed, [60]);
    assert.equal(result.batchesReceived, 1);
    assert.equal(result.batchesProcessed, 1);
    assert.equal(result.batchesCommitted, 0);
    assert.equal(result.stopReason, "lease-lost");
    assert.equal(a.checkpoint, -1);
    assert.equal(await store.getCheckpoint("orders-0"), undefined);
  });

  test("a fresh owner can preempt an active lease and old batches stay rejected", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a");
    const b = owner(store, clock, "worker-b");
    const leaseA = await a.acquire();
    const oldReceiver = a.createEpochReceiver();
    const oldBatch = await batchFrom(oldReceiver, 70);

    const leaseB = await b.preempt();
    assert.equal(leaseB.epoch, 2);
    assert.equal(leaseB.previousEpoch, 1);
    assert.notEqual(leaseB.etag, leaseA.etag);

    const newBatch = await batchFrom(b.createEpochReceiver(), 71);
    await b.commit(newBatch);
    await assert.rejects(() => a.commit(oldBatch), PreemptedError);

    const conflict = await new PartitionOwnership({
      store,
      workerId: "worker-c",
      partitionId: "orders-0",
      now: () => clock.read(),
    }).tryAcquire();
    assert.equal(conflict.acquired, false);
    assert.equal(conflict.reason, "lease-active");
    assert.equal(conflict.previous?.ownerId, "worker-b");

    await assert.rejects(
      () =>
        new PartitionOwnership({
          store,
          workerId: "worker-c",
          partitionId: "orders-0",
          now: () => clock.read(),
        }).acquire(),
      (error: unknown) => error instanceof OwnershipConflictError,
    );
  });

  test("a new epoch continues from the last committed watermark", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a");
    const b = owner(store, clock, "worker-b");
    await a.acquire();

    const oldReceiver = a.createEpochReceiver();
    const beforeTakeover = await batchFrom(oldReceiver, 80);
    assert.equal((await a.commit(beforeTakeover)).sequenceNumber, 80);

    const leaseB = await b.acquire({ preempt: true });
    assert.equal(leaseB.epoch, 2);
    assert.equal(b.checkpoint, 80);

    const newReceiver = b.createEpochReceiver();
    const afterTakeover = await batchFrom(newReceiver, 81);
    const checkpoint = await b.commit(afterTakeover);
    assert.equal(checkpoint.sequenceNumber, 81);
    assert.equal(checkpoint.epoch, 2);
    assert.equal((await store.getCheckpoint("orders-0"))?.sequenceNumber, 81);

    await assert.rejects(() => a.commit({ ...beforeTakeover, sequenceNumber: 82 }));
    assert.equal((await store.getCheckpoint("orders-0"))?.sequenceNumber, 81);
  });

  test("an explicit higher epoch preempts even when the owner is unchanged", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a");
    const first = await a.acquire();
    a.createEpochReceiver().enqueue({ sequenceNumber: 90 });

    const second = await a.acquire({ epoch: first.epoch + 4 });
    assert.equal(second.epoch, 5);
    assert.notEqual(second.etag, first.etag);

    await assert.rejects(
      () =>
        a.commit({
          partitionId: "orders-0",
          epoch: first.epoch,
          etag: first.etag,
          sequenceNumber: 91,
        }),
      PreemptedError,
    );
  });

  test("controllable storage holds a commit at a deterministic point", async () => {
    const { clock, store } = fixture();
    const a = owner(store, clock, "worker-a");
    await a.acquire();
    const receiver = a.createEpochReceiver();
    const batch = await batchFrom(receiver, 100);

    const gate = store.holdNext("commit");
    const committing = a.commit(batch);
    await gate.entered;
    assert.equal(await store.getCheckpoint("orders-0"), undefined);
    assert.equal(a.checkpoint, -1);

    gate.release();
    const checkpoint = await committing;
    assert.equal(checkpoint.sequenceNumber, 100);
    assert.equal((await store.getCheckpoint("orders-0"))?.sequenceNumber, 100);
  });
});
