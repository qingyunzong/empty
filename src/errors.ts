export type ProtocolErrorCode =
  | "stray-crlf"
  | "invalid-length"
  | "invalid-integer"
  | "invalid-null"
  | "invalid-blob-terminator"
  | "invalid-marker"
  | "invalid-context"
  | "unsupported-type"
  | "unsupported-feature"
  | "nested-push"
  | "map-odd"
  | "limit-header"
  | "limit-depth"
  | "limit-nodes"
  | "limit-attributes"
  | "limit-leaf";

/** A permanent protocol, structural, or budget failure. */
export class RespProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  /** Absolute byte offset associated with the failure. */
  readonly offset: number;

  constructor(code: ProtocolErrorCode, message: string, offset: number) {
    super(message);
    this.name = "RespProtocolError";
    this.code = code;
    this.offset = offset;
  }
}

export type DemuxErrorCode =
  | "duplicate-ticket"
  | "unknown-ticket"
  | "ticket-not-pending"
  | "decoder-closed";

export class DemuxError extends Error {
  readonly code: DemuxErrorCode;
  readonly ticket: unknown;

  constructor(code: DemuxErrorCode, message: string, ticket?: unknown) {
    super(message);
    this.name = "DemuxError";
    this.code = code;
    this.ticket = ticket;
  }
}

export type DecoderErrorCode = "decoder-finished";

export class DecoderStateError extends Error {
  readonly code: DecoderErrorCode;

  constructor(code: DecoderErrorCode, message: string) {
    super(message);
    this.name = "DecoderStateError";
    this.code = code;
  }
}
