import type {
  Checkpoint,
  CheckpointStore,
  DeliveryEvidence,
  Interval,
} from "./types.ts";

function cloneInterval(interval: Interval): Interval {
  return { from: interval.from, to: interval.to };
}

function cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return {
    version: 1,
    streamId: checkpoint.streamId,
    k: checkpoint.k,
    scan: cloneInterval(checkpoint.scan),
    confirmedThrough: checkpoint.confirmedThrough,
    snapshotToken: checkpoint.snapshotToken,
    snapshotGeneration: checkpoint.snapshotGeneration,
    snapshotRange: cloneInterval(checkpoint.snapshotRange),
    pending: checkpoint.pending.map(cloneInterval),
    retiredSnapshots: checkpoint.retiredSnapshots.map((retired) => ({
      token: retired.token,
      generation: retired.generation,
      reason: retired.reason,
      pending: retired.pending.map(cloneInterval),
    })),
  };
}

function cloneEvidence(evidence: DeliveryEvidence): DeliveryEvidence {
  return {
    deliveryId: evidence.deliveryId,
    bucketId: evidence.bucketId,
    snapshotToken: evidence.snapshotToken,
    snapshotGeneration: evidence.snapshotGeneration,
    interval: cloneInterval(evidence.interval),
    attempt: evidence.attempt,
    records: evidence.records.map((record) => ({
      id: record.id,
      time: record.time,
      content: record.content,
    })),
  };
}

/**
 * Small in-memory implementation suitable for tests and single-process hosts.
 * It copies values on the way in and out so callers cannot mutate durable state.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoint: Checkpoint | null = null;
  private readonly evidences: DeliveryEvidence[] = [];
  saveCount = 0;
  evidenceCount = 0;

  loadCheckpoint(): Checkpoint | null {
    return this.checkpoint === null ? null : cloneCheckpoint(this.checkpoint);
  }

  saveCheckpoint(checkpoint: Checkpoint): void {
    this.checkpoint = cloneCheckpoint(checkpoint);
    this.saveCount += 1;
  }

  appendEvidence(evidence: DeliveryEvidence): void {
    this.evidences.push(cloneEvidence(evidence));
    this.evidenceCount += 1;
  }

  getCheckpoint(): Checkpoint | null {
    return this.loadCheckpoint();
  }

  getEvidence(): readonly DeliveryEvidence[] {
    return this.evidences.map(cloneEvidence);
  }
}
