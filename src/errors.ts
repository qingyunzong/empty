/**
 * Machine-readable error codes for the delta queue state machine.
 * Callers can branch on `code` instead of parsing error messages.
 */
export type DeltaQueueErrorCode =
  | 'INVALID_ARGUMENT'
  | 'GENERATION_NOT_FOUND'
  | 'GENERATION_SEALED'
  | 'GENERATION_MISMATCH'
  | 'GENERATION_CONFLICT'
  | 'REQUEST_NOT_FOUND'
  | 'REQUEST_ALREADY_EXISTS'
  | 'REQUEST_NOT_PERSISTED'
  | 'REQUEST_TERMINAL'
  | 'PACKAGE_UNEXPECTED'
  | 'CHECKSUM_CONFLICT';

export class DeltaQueueError extends Error {
  readonly code: DeltaQueueErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: DeltaQueueErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DeltaQueueError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
