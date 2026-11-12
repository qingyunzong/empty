export interface Separators {
  readonly component: string;
  readonly element: string;
  readonly decimal: string;
  readonly release: string;
  readonly repetition: string;
  readonly segment: string;
}

export const DEFAULT_SEPARATORS: Separators = Object.freeze({
  component: ":",
  element: "+",
  decimal: ".",
  release: "?",
  repetition: "*",
  segment: "'",
});

export interface ComponentValue {
  /** Strict UTF-8 decoded data after release removal. */
  readonly text: string;
  /** Original input bytes for this component, including release bytes. */
  readonly raw: Uint8Array;
  /** Absolute byte offset of the first raw byte. */
  readonly byteStart: number;
  /** Absolute byte offset just after the last raw byte. */
  readonly byteEnd: number;
}

/** One repetition is an ordered list of components, including empty values. */
export type Repetition = readonly ComponentValue[];
/** One element is an ordered list of repetitions, including empty values. */
export type Element = readonly Repetition[];

export interface Segment {
  readonly tag: string;
  readonly elements: readonly Element[];
  /** Original segment bytes from tag through the segment terminator. */
  readonly raw: Uint8Array;
  readonly byteStart: number;
  /** Exclusive end offset, including the segment terminator. */
  readonly byteEnd: number;
}

export interface Message {
  readonly unh: Segment;
  readonly body: readonly Segment[];
  readonly unt: Segment;
  readonly ref: string;
  readonly type: string;
  /** Actual segment count, including UNH and UNT. */
  readonly segmentCount: number;
}

export interface Group {
  readonly ung: Segment;
  readonly messages: readonly Message[];
  readonly une: Segment;
  readonly ref: string;
  /** Actual number of messages in the group. */
  readonly count: number;
}

export type ExchangeMode = "direct" | "group";

export interface Exchange {
  readonly unaPresent: boolean;
  /** The original nine UNA bytes, or null when the exchange had no UNA. */
  readonly una: Uint8Array | null;
  readonly separators: Separators;
  readonly unb: Segment;
  readonly unbRef: string;
  readonly mode: ExchangeMode;
  /** Present only in direct mode. Empty exchanges use an empty array. */
  readonly directMessages: readonly Message[] | null;
  /** Present only in group mode. */
  readonly groups: readonly Group[] | null;
  readonly unz: Segment;
  /** Actual UNZ count: messages in direct mode, groups in group mode. */
  readonly count: number;
  /** Exchange start: first UNA byte, or first UNB byte. */
  readonly byteStart: number;
  /** Exclusive exchange end after the UNZ segment terminator. */
  readonly byteEnd: number;
}

export interface ParserLimits {
  /** Maximum bytes consumed by one exchange, including UNA and ignored CR/LF. */
  readonly maxExchangeBytes?: number;
  /** Maximum segments in one exchange, including service segments. */
  readonly maxSegments?: number;
  /** Maximum strict-UTF-8 bytes in one final component. */
  readonly maxComponentBytes?: number;
  /** Maximum repetition values in one element. */
  readonly maxRepetitions?: number;
}

export interface ParserOptions {
  /** Called once for each fully validated exchange, never for a partial one. */
  readonly onExchange?: (exchange: Exchange) => void;
  readonly limits?: ParserLimits;
}
