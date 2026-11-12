import { Rational, type RationalInput } from "./rational.js";

export interface ChannelSpec {
  name?: string;
  /** Positive number of samples in every record for this channel. */
  ns: number;
  digitalMin: RationalInput;
  digitalMax: RationalInput;
  physicalMin: RationalInput;
  physicalMax: RationalInput;
}

export interface RecordHeaderSpec {
  /** C = continuous records, D = discontinuous records. */
  mode: "C" | "D";
  /** Positive rational duration T of every record. */
  recordDuration: RationalInput;
  /** Plain channels, in their on-disk order. */
  channels: ChannelSpec[];
  /** Capacity a of the annotation channel, in bytes (a >= 4). */
  annotationBytes: number;
}

export interface NormalizedChannel {
  readonly channelIndex: number;
  readonly name: string | undefined;
  readonly ns: number;
  readonly digitalMin: Rational;
  readonly digitalMax: Rational;
  readonly physicalMin: Rational;
  readonly physicalMax: Rational;
  /** (physicalMax - physicalMin) / (digitalMax - digitalMin). */
  readonly scale: Rational;
  /** T / ns, the exact spacing between samples of this channel. */
  readonly sampleDuration: Rational;
  /** Byte offset of sample zero, relative to the start of a record. */
  readonly byteOffset: number;
}

export interface NormalizedHeader {
  readonly mode: "C" | "D";
  readonly recordDuration: Rational;
  readonly channels: readonly NormalizedChannel[];
  readonly annotationBytes: number;
  readonly sampleBytes: number;
  readonly recordBytes: number;
}

export interface DecodedEvent {
  readonly recordIndex: number;
  readonly talIndex: number;
  readonly annotationIndex: number;
  readonly onsetText: string;
  readonly onset: Rational;
  readonly durationText: string | undefined;
  /** undefined means absent; an explicit "0" is Rational.ZERO. */
  readonly duration: Rational | undefined;
  readonly text: string;
}

export interface DecodedRecord {
  readonly index: number;
  readonly start: Rational;
  /** Absolute byte offset of this record in the delivered input stream. */
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly talCount: number;
  readonly events: readonly DecodedEvent[];
}

export interface SampleSegment {
  readonly recordIndex: number;
  readonly channelIndex: number;
  readonly channelName: string | undefined;
  /** First matching channel-local sample index, inclusive. */
  readonly indexStart: number;
  /** One past the last matching channel-local sample index. */
  readonly indexEnd: number;
  /** Exact time of sample indexStart. */
  readonly firstTime: Rational;
  /** Exact time of sample indexEnd - 1. */
  readonly lastTime: Rational;
  /** Absolute stream byte offset of the first matching int16 sample. */
  readonly byteOffset: number;
  readonly byteLength: number;
}

export type DecodeErrorCode =
  | "INVALID_HEADER"
  | "INCOMPLETE_RECORD"
  | "TAL_TRUNCATED"
  | "TIME_FORMAT"
  | "COMMENT_REQUIRED"
  | "COMMENT_TERMINATOR"
  | "INVALID_UTF8"
  | "INVALID_COMMENT_CHAR"
  | "FIRST_TAL"
  | "EMPTY_TAL"
  | "INVALID_PADDING"
  | "RECORD_START_RANGE"
  | "RECORD_START_ORDER"
  | "INVALID_INDEX";

export class DecodeError extends Error {
  readonly code: DecodeErrorCode;
  readonly recordIndex: number | undefined;
  readonly annotationOffset: number | undefined;

  constructor(
    code: DecodeErrorCode,
    message: string,
    options: { recordIndex?: number; annotationOffset?: number } = {},
  ) {
    super(message);
    this.name = "DecodeError";
    this.code = code;
    this.recordIndex = options.recordIndex;
    this.annotationOffset = options.annotationOffset;
  }
}

export class QueryRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "QueryRangeError";
  }
}

const ONSET_PATTERN = /^[+-][0-9]+(?:\.[0-9]+)?$/;
const DURATION_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export function normalizeHeader(spec: RecordHeaderSpec): NormalizedHeader {
  if (spec.mode !== "C" && spec.mode !== "D") {
    throw new DecodeError("INVALID_HEADER", 'mode must be "C" or "D"');
  }
  const recordDuration = Rational.from(spec.recordDuration, "recordDuration");
  if (!recordDuration.greaterThan(Rational.ZERO)) {
    throw new DecodeError("INVALID_HEADER", "recordDuration must be positive");
  }
  if (!Array.isArray(spec.channels)) {
    throw new DecodeError("INVALID_HEADER", "channels must be an array");
  }
  if (!Number.isSafeInteger(spec.annotationBytes) || spec.annotationBytes < 4) {
    throw new DecodeError(
      "INVALID_HEADER",
      "annotationBytes must be an integer >= 4",
    );
  }

  let sampleBytes = 0;
  const channels: NormalizedChannel[] = [];
  for (let channelIndex = 0; channelIndex < spec.channels.length; channelIndex++) {
    const channel = spec.channels[channelIndex];
    if (!channel || !Number.isSafeInteger(channel.ns) || channel.ns <= 0) {
      throw new DecodeError(
        "INVALID_HEADER",
        `channel ${channelIndex}: ns must be a positive integer`,
      );
    }
    if (channel.name !== undefined && typeof channel.name !== "string") {
      throw new DecodeError(
        "INVALID_HEADER",
        `channel ${channelIndex}: name must be a string`,
      );
    }
    const digitalMin = Rational.from(
      channel.digitalMin,
      `channel ${channelIndex} digitalMin`,
    );
    const digitalMax = Rational.from(
      channel.digitalMax,
      `channel ${channelIndex} digitalMax`,
    );
    if (!digitalMin.lessThan(digitalMax)) {
      throw new DecodeError(
        "INVALID_HEADER",
        `channel ${channelIndex}: digitalMin must be less than digitalMax`,
      );
    }
    const physicalMin = Rational.from(
      channel.physicalMin,
      `channel ${channelIndex} physicalMin`,
    );
    const physicalMax = Rational.from(
      channel.physicalMax,
      `channel ${channelIndex} physicalMax`,
    );
    if (physicalMin.equals(physicalMax)) {
      throw new DecodeError(
        "INVALID_HEADER",
        `channel ${channelIndex}: physicalMin and physicalMax must differ`,
      );
    }
    const byteOffset = sampleBytes;
    sampleBytes += channel.ns * 2;
    if (!Number.isSafeInteger(sampleBytes)) {
      throw new DecodeError("INVALID_HEADER", "record size is too large");
    }
    channels.push(
      Object.freeze({
        channelIndex,
        name: channel.name,
        ns: channel.ns,
        digitalMin,
        digitalMax,
        physicalMin,
        physicalMax,
        scale: physicalMax.sub(physicalMin).div(digitalMax.sub(digitalMin)),
        sampleDuration: recordDuration.div(BigInt(channel.ns)),
        byteOffset,
      }),
    );
  }

  const recordBytes = sampleBytes + spec.annotationBytes;
  if (!Number.isSafeInteger(recordBytes)) {
    throw new DecodeError("INVALID_HEADER", "record size is too large");
  }

  return Object.freeze({
    mode: spec.mode,
    recordDuration,
    channels: Object.freeze(channels),
    annotationBytes: spec.annotationBytes,
    sampleBytes,
    recordBytes,
  });
}

interface ParsedComment {
  readonly text: string;
  readonly byteOffset: number;
}

interface ParsedTal {
  readonly onsetText: string;
  readonly onset: Rational;
  readonly durationText: string | undefined;
  readonly duration: Rational | undefined;
  readonly comments: readonly ParsedComment[];
  readonly nextOffset: number;
}

function asciiField(
  bytes: Uint8Array,
  field: string,
  signed: boolean,
): string {
  let value = "";
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    const digit = byte >= 0x30 && byte <= 0x39;
    const decimalPoint = byte === 0x2e;
    const sign = signed && (byte === 0x2b || byte === 0x2d);
    if (!digit && !decimalPoint && !sign) {
      throw new DecodeError(
        "TIME_FORMAT",
        `${field} contains a character outside its decimal grammar`,
      );
    }
    value += String.fromCharCode(byte);
  }
  if (bytes.length === 0) {
    throw new DecodeError("TIME_FORMAT", `${field} must not be empty`);
  }
  return value;
}

function parseTimeText(text: string, signed: boolean): Rational {
  let sign = 1n;
  let body = text;
  if (signed) {
    if (body[0] === "+") {
      body = body.slice(1);
    } else if (body[0] === "-") {
      sign = -1n;
      body = body.slice(1);
    } else {
      throw new DecodeError("TIME_FORMAT", "onset must start with + or -");
    }
  }
  const dot = body.indexOf(".");
  const whole = dot < 0 ? body : body.slice(0, dot);
  const fraction = dot < 0 ? "" : body.slice(dot + 1);
  if (whole.length === 0 || (dot >= 0 && fraction.length === 0)) {
    throw new DecodeError("TIME_FORMAT", "invalid decimal time");
  }
  return new Rational(
    sign * BigInt(`${whole}${fraction}`),
    10n ** BigInt(fraction.length),
  );
}

function decodeComment(bytes: Uint8Array, offset: number): string {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new DecodeError("INVALID_UTF8", "comment is not valid UTF-8", {
      annotationOffset: offset,
    });
  }
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      throw new DecodeError(
        "INVALID_COMMENT_CHAR",
        `comment contains forbidden control character U+${code
          .toString(16)
          .padStart(4, "0")
          .toUpperCase()}`,
        { annotationOffset: offset },
      );
    }
  }
  return text;
}

function parseTal(
  data: Uint8Array,
  start: number,
  recordIndex: number,
): ParsedTal {
  const limit = data.length;
  let position = start;
  let onsetEnd = position;
  while (
    onsetEnd < limit &&
    data[onsetEnd] !== 0x14 &&
    data[onsetEnd] !== 0x15
  ) {
    onsetEnd++;
  }
  if (onsetEnd >= limit) {
    throw new DecodeError("TAL_TRUNCATED", "TAL ends before its onset delimiter", {
      recordIndex,
      annotationOffset: start,
    });
  }

  const onsetText = asciiField(
    data.subarray(position, onsetEnd),
    "onset",
    true,
  );
  if (!ONSET_PATTERN.test(onsetText)) {
    throw new DecodeError("TIME_FORMAT", `invalid onset ${JSON.stringify(onsetText)}`, {
      recordIndex,
      annotationOffset: start,
    });
  }
  const onset = parseTimeText(onsetText, true);
  position = onsetEnd;

  let durationText: string | undefined;
  let duration: Rational | undefined;
  if (data[position] === 0x15) {
    position++;
    const durationStart = position;
    while (position < limit && data[position] !== 0x14) {
      position++;
    }
    if (position >= limit) {
      throw new DecodeError(
        "TAL_TRUNCATED",
        "TAL ends before its duration delimiter",
        { recordIndex, annotationOffset: durationStart },
      );
    }
    durationText = asciiField(
      data.subarray(durationStart, position),
      "duration",
      false,
    );
    if (!DURATION_PATTERN.test(durationText)) {
      throw new DecodeError(
        "TIME_FORMAT",
        `invalid duration ${JSON.stringify(durationText)}`,
        { recordIndex, annotationOffset: durationStart },
      );
    }
    duration = parseTimeText(durationText, false);
  }

  // Consume the 0x14 that separates the time fields from comments.
  if (data[position] !== 0x14) {
    throw new DecodeError("TIME_FORMAT", "missing time-field delimiter", {
      recordIndex,
      annotationOffset: position,
    });
  }
  position++;

  const comments: ParsedComment[] = [];
  while (true) {
    if (position >= limit) {
      throw new DecodeError("TAL_TRUNCATED", "TAL has no 0x00 terminator", {
        recordIndex,
        annotationOffset: position,
      });
    }
    if (data[position] === 0x00) {
      if (comments.length === 0) {
        throw new DecodeError("COMMENT_REQUIRED", "TAL must contain a comment field", {
          recordIndex,
          annotationOffset: position,
        });
      }
      position++;
      break;
    }

    const commentStart = position;
    while (
      position < limit &&
      data[position] !== 0x14 &&
      data[position] !== 0x00
    ) {
      position++;
    }
    if (position >= limit) {
      throw new DecodeError("TAL_TRUNCATED", "comment is not terminated", {
        recordIndex,
        annotationOffset: commentStart,
      });
    }
    if (data[position] === 0x00) {
      throw new DecodeError(
        "COMMENT_TERMINATOR",
        "comment must end with 0x14 before the TAL terminator",
        { recordIndex, annotationOffset: commentStart },
      );
    }
    comments.push({
      text: decodeComment(data.subarray(commentStart, position), commentStart),
      byteOffset: commentStart,
    });
    position++; // the 0x14 comment terminator
  }

  return {
    onsetText,
    onset,
    durationText,
    duration,
    comments,
    nextOffset: position,
  };
}

interface ParsedAnnotation {
  readonly start: Rational;
  readonly events: readonly DecodedEvent[];
  readonly talCount: number;
}

function parseAnnotation(
  data: Uint8Array,
  recordIndex: number,
): ParsedAnnotation {
  const tals: ParsedTal[] = [];
  let position = 0;

  while (position < data.length) {
    if (data[position] === 0x00) {
      for (let index = position; index < data.length; index++) {
        if (data[index] !== 0x00) {
          throw new DecodeError(
            "INVALID_PADDING",
            "all bytes after zero padding must be zero",
            { recordIndex, annotationOffset: index },
          );
        }
      }
      break;
    }
    const tal = parseTal(data, position, recordIndex);
    tals.push(tal);
    position = tal.nextOffset;
  }

  if (tals.length === 0) {
    throw new DecodeError(
      "FIRST_TAL",
      "record has no TAL carrying its start onset",
      { recordIndex, annotationOffset: 0 },
    );
  }

  const first = tals[0];
  if (
    first.duration !== undefined ||
    first.comments.length !== 1 ||
    first.comments[0].text !== ""
  ) {
    throw new DecodeError(
      "FIRST_TAL",
      "first TAL must be onset 0x14 0x14 0x00 with no duration",
      { recordIndex, annotationOffset: 0 },
    );
  }
  const start = first.onset;

  const events: DecodedEvent[] = [];
  for (let talIndex = 1; talIndex < tals.length; talIndex++) {
    const tal = tals[talIndex];
    if (!tal.comments.some((comment) => comment.text.length > 0)) {
      throw new DecodeError(
        "EMPTY_TAL",
        "TAL after the first must contain a non-empty comment",
        { recordIndex, annotationOffset: tal.comments[0]?.byteOffset ?? 0 },
      );
    }
    for (
      let annotationIndex = 0;
      annotationIndex < tal.comments.length;
      annotationIndex++
    ) {
      const comment = tal.comments[annotationIndex];
      events.push(
        Object.freeze({
          recordIndex,
          talIndex,
          annotationIndex,
          onsetText: tal.onsetText,
          onset: tal.onset,
          durationText: tal.durationText,
          duration: tal.duration,
          text: comment.text,
        }),
      );
    }
  }

  return {
    start,
    events: Object.freeze(events),
    talCount: tals.length,
  };
}

interface StoredRecord {
  readonly publicRecord: DecodedRecord;
  readonly bytes: Uint8Array;
}

function rationalInput(value: RationalInput, label: string): Rational {
  try {
    return Rational.from(value, label);
  } catch (error) {
    if (error instanceof Error) {
      throw new QueryRangeError(error.message);
    }
    throw error;
  }
}

/**
 * Incremental record decoder. Records are committed only after the complete
 * record, including its annotation area, has passed validation.
 */
export class RecordDecoder {
  readonly header: NormalizedHeader;
  readonly recordBytes: number;

  #stored: StoredRecord[] = [];
  #pending: Uint8Array = new Uint8Array(0);
  #failure: DecodeError | undefined;

  constructor(header: RecordHeaderSpec | NormalizedHeader) {
    this.header =
      "recordBytes" in header && typeof header.recordBytes === "number"
        ? (header as NormalizedHeader)
        : normalizeHeader(header as RecordHeaderSpec);
    this.recordBytes = this.header.recordBytes;
  }

  get records(): readonly DecodedRecord[] {
    return this.#stored.map((stored) => stored.publicRecord);
  }

  get pendingBytes(): number {
    return this.#pending.length;
  }

  get error(): DecodeError | undefined {
    return this.#failure;
  }

  /**
   * Feeds an arbitrary byte chunk. Returns the records committed by this call.
   * If a later record is invalid, all earlier records remain committed and
   * queryable; the failure is reported by throwing a DecodeError.
   */
  push(chunk: Uint8Array): DecodedRecord[] {
    if (this.#failure) {
      throw this.#failure;
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("chunk must be a Uint8Array");
    }
    if (chunk.length === 0) {
      return [];
    }

    const committed: DecodedRecord[] = [];
    let position = 0;

    try {
      if (this.#pending.length > 0) {
        const needed = this.recordBytes - this.#pending.length;
        if (chunk.length < needed) {
          this.#appendPending(chunk);
          return committed;
        }
        const recordBytes = new Uint8Array(this.recordBytes);
        recordBytes.set(this.#pending, 0);
        recordBytes.set(chunk.subarray(0, needed), this.#pending.length);
        this.#pending = new Uint8Array(0);
        position = needed;
        committed.push(this.#commit(recordBytes));
      }

      while (chunk.length - position >= this.recordBytes) {
        const recordBytes = new Uint8Array(this.recordBytes);
        recordBytes.set(chunk.subarray(position, position + this.recordBytes));
        position += this.recordBytes;
        committed.push(this.#commit(recordBytes));
      }

      if (position < chunk.length) {
        this.#pending = new Uint8Array(chunk.subarray(position));
      }
      return committed;
    } catch (error) {
      if (error instanceof DecodeError && !this.#failure) {
        this.#failure = error;
      }
      throw error;
    }
  }

  /** Verifies that no partial record remains after the last chunk. */
  finish(): void {
    if (this.#failure) {
      throw this.#failure;
    }
    if (this.#pending.length !== 0) {
      const error = new DecodeError(
        "INCOMPLETE_RECORD",
        `input ended with ${this.#pending.length} bytes of a partial record`,
        { recordIndex: this.#stored.length },
      );
      this.#failure = error;
      throw error;
    }
  }

  /**
   * Returns one contiguous segment per (record, channel) that has samples in
   * the half-open rational interval [from, to).
   */
  querySamples(from: RationalInput, to: RationalInput): SampleSegment[] {
    const left = rationalInput(from, "from");
    const right = rationalInput(to, "to");
    if (left.greaterThan(right)) {
      throw new QueryRangeError("sample query requires from <= to");
    }
    if (left.equals(right)) {
      return [];
    }

    const result: SampleSegment[] = [];
    for (const stored of this.#stored) {
      const record = stored.publicRecord;
      for (const channel of this.header.channels) {
        const localStart = left.sub(record.start).div(channel.sampleDuration);
        const localEnd = right.sub(record.start).div(channel.sampleDuration);
        let indexStart = Number(localStart.ceil());
        let indexEnd = Number(localEnd.ceil());
        if (indexStart < 0) indexStart = 0;
        if (indexStart > channel.ns) indexStart = channel.ns;
        if (indexEnd < 0) indexEnd = 0;
        if (indexEnd > channel.ns) indexEnd = channel.ns;
        if (indexStart >= indexEnd) {
          continue;
        }
        result.push(
          Object.freeze({
            recordIndex: record.index,
            channelIndex: channel.channelIndex,
            channelName: channel.name,
            indexStart,
            indexEnd,
            firstTime: record.start.add(
              channel.sampleDuration.mul(BigInt(indexStart)),
            ),
            lastTime: record.start.add(
              channel.sampleDuration.mul(BigInt(indexEnd - 1)),
            ),
            byteOffset:
              record.byteOffset + channel.byteOffset + indexStart * 2,
            byteLength: (indexEnd - indexStart) * 2,
          }),
        );
      }
    }
    return result;
  }

  /**
   * Selects events by onset in [from, to), preserving record/TAL/annotation
   * order. Duration is not used for selection.
   */
  queryEvents(from: RationalInput, to: RationalInput): DecodedEvent[] {
    const left = rationalInput(from, "from");
    const right = rationalInput(to, "to");
    if (left.greaterThan(right)) {
      throw new QueryRangeError("event query requires from <= to");
    }
    if (left.equals(right)) {
      return [];
    }

    const result: DecodedEvent[] = [];
    for (const stored of this.#stored) {
      for (const event of stored.publicRecord.events) {
        if (event.onset.greaterThanOrEqual(left) && event.onset.lessThan(right)) {
          result.push(event);
        }
      }
    }
    return result;
  }

  /** Reads one little-endian int16 sample exactly as stored. */
  readSample(
    recordIndex: number,
    channelIndex: number,
    sampleIndex: number,
  ): number {
    const { stored, channel } = this.#locateSample(
      recordIndex,
      channelIndex,
      sampleIndex,
    );
    const offset = channel.byteOffset + sampleIndex * 2;
    return new DataView(
      stored.bytes.buffer,
      stored.bytes.byteOffset,
      stored.bytes.byteLength,
    ).getInt16(offset, true);
  }

  /** Converts a stored int16 to its exact physical rational without clipping. */
  sampleValue(
    recordIndex: number,
    channelIndex: number,
    sampleIndex: number,
  ): Rational {
    const { channel } = this.#locateSample(
      recordIndex,
      channelIndex,
      sampleIndex,
    );
    const raw = BigInt(
      this.readSample(recordIndex, channelIndex, sampleIndex),
    );
    return channel.physicalMin.add(
      new Rational(raw).sub(channel.digitalMin).mul(channel.scale),
    );
  }

  /** Reads a contiguous run of raw samples as int16 values. */
  readSamples(
    recordIndex: number,
    channelIndex: number,
    sampleIndex: number,
    count: number,
  ): Int16Array {
    const { stored, channel } = this.#locateSample(
      recordIndex,
      channelIndex,
      sampleIndex,
    );
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("count must be a non-negative integer");
    }
    if (sampleIndex + count > channel.ns) {
      throw new DecodeError(
        "INVALID_INDEX",
        "sample run extends past the end of the channel record",
      );
    }
    const view = new DataView(
      stored.bytes.buffer,
      stored.bytes.byteOffset,
      stored.bytes.byteLength,
    );
    const values = new Int16Array(count);
    for (let index = 0; index < count; index++) {
      values[index] = view.getInt16(channel.byteOffset + (sampleIndex + index) * 2, true);
    }
    return values;
  }

  /** Returns a defensive copy of a committed record's bytes. */
  readRecordBytes(recordIndex: number): Uint8Array {
    if (!Number.isSafeInteger(recordIndex) || recordIndex < 0) {
      throw new DecodeError("INVALID_INDEX", "recordIndex must be non-negative");
    }
    const stored = this.#stored[recordIndex];
    if (!stored) {
      throw new DecodeError(
        "INVALID_INDEX",
        `record ${recordIndex} has not been committed`,
      );
    }
    return stored.bytes.slice();
  }

  #appendPending(chunk: Uint8Array): void {
    const combined = new Uint8Array(this.#pending.length + chunk.length);
    combined.set(this.#pending, 0);
    combined.set(chunk, this.#pending.length);
    this.#pending = combined;
  }

  #commit(bytes: Uint8Array): DecodedRecord {
    const recordIndex = this.#stored.length;
    let annotation: ParsedAnnotation;
    try {
      const annotationBytes = bytes.subarray(
        this.header.sampleBytes,
        this.header.sampleBytes + this.header.annotationBytes,
      );
      annotation = parseAnnotation(annotationBytes, recordIndex);
    } catch (error) {
      if (error instanceof DecodeError && error.recordIndex === undefined) {
        throw new DecodeError(error.code, error.message, {
          recordIndex,
          annotationOffset: error.annotationOffset,
        });
      }
      throw error;
    }

    if (recordIndex === 0) {
      if (
        annotation.start.lessThan(Rational.ZERO) ||
        !annotation.start.lessThan(Rational.ONE)
      ) {
        throw new DecodeError(
          "RECORD_START_RANGE",
          "first record start must satisfy 0 <= start < 1",
          { recordIndex, annotationOffset: 0 },
        );
      }
    } else {
      const previous = this.#stored[recordIndex - 1].publicRecord.start;
      const earliest = previous.add(this.header.recordDuration);
      if (this.header.mode === "C") {
        if (!annotation.start.equals(earliest)) {
          throw new DecodeError(
            "RECORD_START_ORDER",
            `C-mode record start ${annotation.start} must equal ${earliest}`,
            { recordIndex, annotationOffset: 0 },
          );
        }
      } else if (!annotation.start.greaterThanOrEqual(earliest)) {
        throw new DecodeError(
          "RECORD_START_ORDER",
          `D-mode record start ${annotation.start} must be >= ${earliest}`,
          { recordIndex, annotationOffset: 0 },
        );
      }
    }

    const publicRecord: DecodedRecord = Object.freeze({
      index: recordIndex,
      start: annotation.start,
      byteOffset: recordIndex * this.recordBytes,
      byteLength: this.recordBytes,
      talCount: annotation.talCount,
      events: annotation.events,
    });
    this.#stored.push({ publicRecord, bytes });
    return publicRecord;
  }

  #locateSample(
    recordIndex: number,
    channelIndex: number,
    sampleIndex: number,
  ): { stored: StoredRecord; channel: NormalizedChannel } {
    if (!Number.isSafeInteger(recordIndex) || recordIndex < 0) {
      throw new DecodeError("INVALID_INDEX", "recordIndex must be non-negative");
    }
    if (!Number.isSafeInteger(channelIndex) || channelIndex < 0) {
      throw new DecodeError("INVALID_INDEX", "channelIndex must be non-negative");
    }
    const stored = this.#stored[recordIndex];
    if (!stored) {
      throw new DecodeError(
        "INVALID_INDEX",
        `record ${recordIndex} has not been committed`,
      );
    }
    const channel = this.header.channels[channelIndex];
    if (!channel) {
      throw new DecodeError(
        "INVALID_INDEX",
        `channel ${channelIndex} does not exist`,
      );
    }
    if (
      !Number.isSafeInteger(sampleIndex) ||
      sampleIndex < 0 ||
      sampleIndex >= channel.ns
    ) {
      throw new DecodeError(
        "INVALID_INDEX",
        `sample index must be in [0, ${channel.ns})`,
      );
    }
    return { stored, channel };
  }
}

export function decodeAll(
  header: RecordHeaderSpec | NormalizedHeader,
  bytes: Uint8Array,
  chunkSize?: number,
): DecodedRecord[] {
  const decoder = new RecordDecoder(header);
  if (chunkSize === undefined) {
    decoder.push(bytes);
  } else {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError("chunkSize must be a positive integer");
    }
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      decoder.push(bytes.slice(offset, Math.min(bytes.length, offset + chunkSize)));
    }
  }
  decoder.finish();
  return decoder.records.slice();
}
