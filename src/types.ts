/**
 * The value grammar implemented by this package. It deliberately does not
 * describe the whole of RESP3.
 */

export interface MapEntry {
  key: RespValue;
  value: RespValue;
}

/** Attributes are ordered and may contain duplicate keys. */
export type AttributePair = MapEntry;

interface ValueBase {
  /** Attributes that appeared immediately before this value. */
  attributes: AttributePair[];
}

export interface SimpleStringValue extends ValueBase {
  type: "simple-string";
  /** Raw bytes between the leading "+" and the terminating CRLF. */
  value: Uint8Array;
}

export interface SimpleErrorValue extends ValueBase {
  type: "simple-error";
  /** Raw bytes between the leading "-" and the terminating CRLF. */
  value: Uint8Array;
}

export interface IntegerValue extends ValueBase {
  type: "integer";
  value: bigint;
}

export interface NullValue extends ValueBase {
  type: "null";
}

export interface BlobValue extends ValueBase {
  type: "blob";
  /**
   * The physical chunks supplied by the stream. A fixed "$n" value has one
   * chunk (possibly empty); "$?" has one chunk per non-empty ";n" segment.
   */
  chunks: Uint8Array[];
  /** Logical content: the concatenation of `chunks`, without chunk headers. */
  value: Uint8Array;
}

export interface ArrayValue extends ValueBase {
  type: "array";
  value: RespValue[];
}

export interface MapValue extends ValueBase {
  type: "map";
  /** Ordered key/value pairs, including duplicates. */
  value: MapEntry[];
}

export type RespValue =
  | SimpleStringValue
  | SimpleErrorValue
  | IntegerValue
  | NullValue
  | BlobValue
  | ArrayValue
  | MapValue;

/** A half-open range in the physical byte stream fed to the decoder. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface ValueMessage {
  type: "value";
  value: RespValue;
  /** Same array as `value.attributes`, exposed for convenient host use. */
  attributes: AttributePair[];
  range: ByteRange;
}

export interface PushMessage {
  type: "push";
  /** Attributes attached to the push itself, not to its payload values. */
  attributes: AttributePair[];
  values: RespValue[];
  range: ByteRange;
}

export type DecodedMessage = ValueMessage | PushMessage;

export type TruncationReason =
  | "partial-header"
  | "partial-blob"
  | "unclosed-container"
  | "orphan-attributes";

export interface CleanFinish {
  clean: true;
  ok: true;
  /** Complete messages parsed but not yet consumed by Next. */
  pendingMessages: number;
}

export interface TruncatedFinish {
  clean: false;
  ok: false;
  reason: TruncationReason;
  /** Absolute offset of the end of the fed bytes (the truncation point). */
  at: number;
  /** Complete messages parsed before the incomplete tail, still consumable. */
  pendingMessages: number;
  openContainers: number;
  pendingAttributes: boolean;
  detail: string;
}

export type FinishResult = CleanFinish | TruncatedFinish;

export type DeliveryDisposition =
  | "matched"
  | "discarded"
  | "unsolicited"
  | "push";

export type Delivery<Ticket> =
  | {
      disposition: "push";
      ticket: null;
      message: PushMessage;
    }
  | {
      disposition: "matched" | "discarded";
      ticket: Ticket;
      message: ValueMessage;
    }
  | {
      disposition: "unsolicited";
      ticket: null;
      message: ValueMessage;
    };
