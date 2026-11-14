export type SelectionErrorCode =
  | "MISSING_BUSINESS_KEY"
  | "DUPLICATE_BUSINESS_KEY"
  | "ROW_NOT_FOUND"
  | "DISABLED_ROW"
  | "SNAPSHOT_CONFIRMATION_FAILED"
  | "ADAPTER_ERROR"
  | "PREDICATE_ERROR";

export interface SelectionErrorOptions {
  key?: unknown;
  index?: number;
  cause?: unknown;
  details?: Record<string, unknown>;
}

/**
 * Base error for the selection component. RPA callers can branch on `code`
 * without having to parse messages.
 */
export class TableSelectionError extends Error {
  readonly code: SelectionErrorCode;
  readonly key: unknown;
  readonly index: number | undefined;
  readonly details: Record<string, unknown>;

  constructor(
    code: SelectionErrorCode,
    message: string,
    options: SelectionErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TableSelectionError";
    this.code = code;
    this.key = options.key;
    this.index = options.index;
    this.details = options.details ?? {};
  }
}

export class MissingBusinessKeyError extends TableSelectionError {
  constructor(options: SelectionErrorOptions = {}) {
    super(
      "MISSING_BUSINESS_KEY",
      options.index === undefined
        ? "A row is missing its business key."
        : `The row at index ${options.index} is missing its business key.`,
      options,
    );
    this.name = "MissingBusinessKeyError";
  }
}

export class DuplicateBusinessKeyError extends TableSelectionError {
  constructor(
    key: unknown,
    firstIndex: number | undefined,
    duplicateIndex: number | undefined,
  ) {
    super(
      "DUPLICATE_BUSINESS_KEY",
      `Duplicate business key ${JSON.stringify(key)} (first seen at index ${
        firstIndex ?? "?"
      }, repeated at index ${duplicateIndex ?? "?"}).`,
      {
        key,
        index: duplicateIndex,
        details: { firstIndex, duplicateIndex },
      },
    );
    this.name = "DuplicateBusinessKeyError";
  }
}

export class RowNotFoundError extends TableSelectionError {
  constructor(key: unknown) {
    super(
      "ROW_NOT_FOUND",
      `No row with business key ${JSON.stringify(key)} was found in the current snapshot.`,
      { key },
    );
    this.name = "RowNotFoundError";
  }
}

export class DisabledRowError extends TableSelectionError {
  constructor(key: unknown) {
    super(
      "DISABLED_ROW",
      `The row with business key ${JSON.stringify(key)} is disabled.`,
      { key },
    );
    this.name = "DisabledRowError";
  }
}

export class SnapshotConfirmationError extends TableSelectionError {
  constructor(
    key: unknown,
    expectedChecked: boolean,
    actualChecked: boolean | undefined,
  ) {
    super(
      "SNAPSHOT_CONFIRMATION_FAILED",
      `The post-action snapshot could not confirm ${expectedChecked ? "checked" : "unchecked"} state for key ${JSON.stringify(
        key,
      )} (saw ${String(actualChecked)}).`,
      {
        key,
        details: { expectedChecked, actualChecked },
      },
    );
    this.name = "SnapshotConfirmationError";
  }
}

export class AdapterError extends TableSelectionError {
  constructor(message: string, options: SelectionErrorOptions = {}) {
    super("ADAPTER_ERROR", message, options);
    this.name = "AdapterError";
  }
}

export function isFatalSelectionError(error: unknown): boolean {
  return (
    error instanceof MissingBusinessKeyError ||
    error instanceof DuplicateBusinessKeyError ||
    error instanceof DisabledRowError
  );
}

export {
  TableSelectionError as SelectionError,
  MissingBusinessKeyError as MissingKeyError,
  DuplicateBusinessKeyError as DuplicateKeyError,
  SnapshotConfirmationError as SnapshotMismatchError,
  SnapshotConfirmationError as ConfirmationError,
};
