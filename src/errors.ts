import type { SnapshotErrorCode } from "./types.js";

export class SnapshotValidationError extends Error {
  readonly code: SnapshotErrorCode;
  readonly nodeIds: readonly string[];
  readonly slotIds: readonly string[];

  constructor(
    code: SnapshotErrorCode,
    message: string,
    details: {
      readonly nodeIds?: readonly string[];
      readonly slotIds?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = "SnapshotValidationError";
    this.code = code;
    this.nodeIds = Object.freeze([...(details.nodeIds ?? [])]);
    this.slotIds = Object.freeze([...(details.slotIds ?? [])]);
  }
}

export function isSnapshotValidationError(
  value: unknown,
): value is SnapshotValidationError {
  return value instanceof SnapshotValidationError;
}

export class MockAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockAdapterError";
  }
}

export class LocatorQueryError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "LocatorQueryError";
  }
}
