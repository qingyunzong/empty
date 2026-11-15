export type DeltaSyncErrorCode =
  | "INVALID_OPTIONS"
  | "NO_FETCHER"
  | "NO_START_LINK"
  | "CURSOR_READ_FAILED"
  | "CURSOR_CONFLICT"
  | "FETCH_FAILED"
  | "HTTP_ERROR"
  | "INVALID_PAGE"
  | "MISSING_DELTA_LINK"
  | "DELTA_LOOP"
  | "MAX_PAGES"
  | "COMMIT_FAILED"
  | "INVALID_CHECKPOINT"
  | "RESOURCE_MISMATCH"
  | "BUSY";

export interface DeltaSyncErrorOptions {
  readonly resumable?: boolean | undefined;
  readonly url?: string | undefined;
  readonly page?: number | undefined;
  readonly cause?: unknown;
}

/**
 * Error raised by the synchronizer. `resumable` means the in-flight round (or
 * the persisted cursor) is still safe to retry; the eventual deltaLink has not
 * been committed.
 */
export class DeltaSyncError extends Error {
  readonly code: DeltaSyncErrorCode;
  readonly resumable: boolean;
  readonly url?: string;
  readonly page?: number;

  constructor(
    message: string,
    code: DeltaSyncErrorCode,
    options: DeltaSyncErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.code = code;
    this.resumable = options.resumable ?? true;
    if (options.url !== undefined) {
      this.url = options.url;
    }
    if (options.page !== undefined) {
      this.page = options.page;
    }
  }
}

/**
 * A malformed OData delta payload.
 */
export class DeltaFormatError extends DeltaSyncError {
  constructor(message: string, options: DeltaSyncErrorOptions = {}) {
    super(message, "INVALID_PAGE", {
      ...options,
      resumable: options.resumable ?? true,
    });
  }
}

export function isDeltaSyncError(error: unknown): error is DeltaSyncError {
  return error instanceof DeltaSyncError;
}
