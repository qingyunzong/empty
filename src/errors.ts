import type {
  CheckpointRecord,
  CommitFailureReason,
  OwnershipRecord,
} from "./types.ts";

export class OwnershipError extends Error {
  readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OwnershipConflictError extends OwnershipError {
  readonly reason: string;
  readonly current?: OwnershipRecord;

  constructor(
    message: string,
    reason: string,
    current?: OwnershipRecord,
    cause?: unknown,
  ) {
    super(message, reason, cause);
    this.reason = reason;
    this.current = current;
  }
}

export class CheckpointRejectedError extends OwnershipError {
  readonly reason: CommitFailureReason | string;
  readonly checkpoint?: CheckpointRecord;
  readonly currentOwnership?: OwnershipRecord;
  readonly batch?: unknown;

  constructor(
    message: string,
    reason: CommitFailureReason | string,
    details: {
      checkpoint?: CheckpointRecord;
      currentOwnership?: OwnershipRecord;
      batch?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, reason, details.cause);
    this.reason = reason;
    this.checkpoint = details.checkpoint;
    this.currentOwnership = details.currentOwnership;
    this.batch = details.batch;
  }
}

export class StaleEpochError extends CheckpointRejectedError {
  constructor(
    message = "ownership epoch was superseded; batch commit rejected",
    details: ConstructorParameters<typeof CheckpointRejectedError>[2] = {},
  ) {
    super(message, "stale-epoch", details);
  }
}

export class PreemptedError extends StaleEpochError {}

export class StaleOwnershipError extends CheckpointRejectedError {
  constructor(
    message = "ownership changed without a matching lease; batch commit rejected",
    details: ConstructorParameters<typeof CheckpointRejectedError>[2] = {},
  ) {
    super(message, "stale-ownership", details);
  }
}

export class LeaseLostError extends CheckpointRejectedError {
  readonly renewReason?: string;

  constructor(
    message = "lease renewal failed; processing may finish the current batch but checkpoint is frozen",
    details: ConstructorParameters<typeof CheckpointRejectedError>[2] & {
      renewReason?: string;
    } = {},
  ) {
    super(message, "lease-lost", details);
    this.renewReason = details.renewReason;
  }
}

export class CheckpointConflictError extends CheckpointRejectedError {
  constructor(
    message = "checkpoint ETag changed; conditional checkpoint write rejected",
    details: ConstructorParameters<typeof CheckpointRejectedError>[2] = {},
  ) {
    super(message, "checkpoint-conflict", details);
  }
}

export class CheckpointRegressionError extends CheckpointRejectedError {
  constructor(
    message = "checkpoint sequence number would move backwards",
    details: ConstructorParameters<typeof CheckpointRejectedError>[2] = {},
  ) {
    super(message, "checkpoint-regression", details);
  }
}

export class LeaseNotHeldError extends CheckpointRejectedError {
  constructor(message = "no active ownership lease is held by this worker") {
    super(message, "not-owned");
  }
}
