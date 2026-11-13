export type CoordinatorErrorCode =
  | "invalid-config"
  | "invalid-message"
  | "invalid-snapshot"
  | "invalid-delta"
  | "snapshot-request-failed"
  | "listener-failed";

export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;
  readonly channel: string | undefined;

  constructor(
    code: CoordinatorErrorCode,
    message: string,
    channel?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CoordinatorError";
    this.code = code;
    this.channel = channel;
  }
}
