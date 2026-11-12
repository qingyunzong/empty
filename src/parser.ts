import {
  byteArrayFromChunk,
  byteOfSeparator,
  decodeStrictUtf8,
  separatorsFromBytes,
} from "./bytes.js";
import { EdifactParseError } from "./errors.js";
import { DEFAULT_SEPARATORS } from "./types.js";
import type {
  ComponentValue,
  Element,
  Exchange,
  ExchangeMode,
  Group,
  Message,
  ParserLimits,
  ParserOptions,
  Repetition,
  Segment,
  Separators,
} from "./types.js";

const SERVICE_TAGS = new Set(["UNA", "UNB", "UNZ", "UNG", "UNE", "UNH", "UNT"]);
const COUNT_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const DEFAULT_LIMITS: Required<ParserLimits> = {
  maxExchangeBytes: 8 * 1024 * 1024,
  maxSegments: 100_000,
  maxComponentBytes: 1024 * 1024,
  maxRepetitions: 100_000,
};

interface ResolvedLimits {
  readonly maxExchangeBytes: number;
  readonly maxSegments: number;
  readonly maxComponentBytes: number;
  readonly maxRepetitions: number;
}

interface MessageBuilder {
  readonly unh: Segment;
  readonly body: Segment[];
  readonly ref: string;
  readonly type: string;
  segmentCount: number;
}

interface GroupBuilder {
  readonly ung: Segment;
  readonly messages: Message[];
  readonly ref: string;
}

interface ExchangeBuilder {
  readonly startOffset: number;
  separators: Separators;
  unaPresent: boolean;
  una: Uint8Array | null;
  unb: Segment | null;
  unbRef: string | null;
  mode: ExchangeMode | null;
  readonly directMessages: Message[];
  readonly groups: Group[];
  readonly groupRefs: Set<string>;
  readonly messageRefs: Set<string>;
  currentGroup: GroupBuilder | null;
  currentMessage: MessageBuilder | null;
  segmentCount: number;
}

type ParserState = "between" | "probe" | "una" | "post_una" | "segment";

function isUppercaseTag(bytes: readonly number[]): boolean {
  return bytes.every((byte) => byte >= 0x41 && byte <= 0x5a);
}

function isServiceTag(tag: string): boolean {
  return SERVICE_TAGS.has(tag);
}

function compareCount(declaredText: string, actual: number, offset: number, label: string): void {
  const actualText = String(actual);
  if (declaredText.length !== actualText.length || declaredText !== actualText) {
    throw new EdifactParseError(
      `${label} count ${declaredText} does not match actual count ${actual}`,
      "count",
      offset,
    );
  }
}

function singleComponent(segment: Segment, index: number, label: string): ComponentValue {
  const element = segment.elements[index];
  if (element === undefined) {
    throw new EdifactParseError(`${label} is missing`, "service-shape", segment.byteStart);
  }
  if (element.length !== 1) {
    throw new EdifactParseError(
      `${label} must have exactly one repetition`,
      "service-shape",
      segment.byteStart,
    );
  }
  const repetition = element[0]!;
  if (repetition.length !== 1) {
    throw new EdifactParseError(
      `${label} must have exactly one component`,
      "service-shape",
      segment.byteStart,
    );
  }
  return repetition[0]!;
}

function serviceShape(segment: Segment, elementCount: number, label: string): ComponentValue[] {
  if (segment.elements.length !== elementCount) {
    throw new EdifactParseError(
      `${label} must contain exactly ${elementCount} element${elementCount === 1 ? "" : "s"}`,
      "service-shape",
      segment.byteStart,
    );
  }
  const values: ComponentValue[] = [];
  for (let index = 0; index < elementCount; index += 1) {
    values.push(singleComponent(segment, index, `${label}[${index}]`));
  }
  return values;
}

function scalarText(segment: Segment, index: number, label: string): string {
  const value = singleComponent(segment, index, label);
  if (value.text.length === 0) {
    throw new EdifactParseError(`${label} must not be empty`, "service-shape", segment.byteStart);
  }
  return value.text;
}

function parseSegmentContent(
  content: readonly number[],
  terminator: number,
  startOffset: number,
  endOffset: number,
  separators: Separators,
  limits: ResolvedLimits,
): Segment {
  const componentByte = byteOfSeparator(separators.component);
  const elementByte = byteOfSeparator(separators.element);
  const releaseByte = byteOfSeparator(separators.release);
  const repetitionByte = byteOfSeparator(separators.repetition);

  if (content.length < 3) {
    throw new EdifactParseError("segment is shorter than a three-letter tag", "tag", startOffset);
  }
  if (!isUppercaseTag(content.slice(0, 3))) {
    throw new EdifactParseError(
      "segment tag must be exactly three uppercase ASCII letters and cannot be released",
      "tag",
      startOffset,
    );
  }
  if (content.length > 3 && content[3] !== elementByte) {
    throw new EdifactParseError(
      "only the element separator may follow a segment tag",
      "tag",
      startOffset,
    );
  }

  const tag = String.fromCharCode(content[0]!, content[1]!, content[2]!);
  const elements: Element[] = [];

  if (content.length > 3) {
    let currentRepetitions: Repetition[] = [];
    let currentRepetition: ComponentValue[] = [];
    let componentRawBytes: number[] = [];
    let componentDataBytes: number[] = [];
    let componentStart = 4;

    const finishComponent = (end: number): void => {
      if (componentDataBytes.length > limits.maxComponentBytes) {
        throw new EdifactParseError(
          `component exceeds the ${limits.maxComponentBytes}-byte limit`,
          "limit-component-bytes",
          startOffset + componentStart,
        );
      }
      const text = decodeStrictUtf8(componentDataBytes, startOffset + componentStart);
      currentRepetition.push(
        Object.freeze({
          text,
          raw: Uint8Array.from(componentRawBytes),
          byteStart: startOffset + componentStart,
          byteEnd: startOffset + end,
        }),
      );
      componentRawBytes = [];
      componentDataBytes = [];
    };

    const finishRepetition = (): void => {
      currentRepetitions.push(Object.freeze(currentRepetition));
      if (currentRepetitions.length > limits.maxRepetitions) {
        throw new EdifactParseError(
          `element exceeds the ${limits.maxRepetitions}-repetition limit`,
          "limit-repetitions",
          startOffset + componentStart,
        );
      }
      currentRepetition = [];
    };

    const finishElement = (end: number): void => {
      finishComponent(end);
      finishRepetition();
      elements.push(Object.freeze(currentRepetitions));
    };

    const startElement = (start: number): void => {
      currentRepetitions = [];
      currentRepetition = [];
      componentRawBytes = [];
      componentDataBytes = [];
      componentStart = start;
    };

    startElement(4);

    let position = 4;
    while (position < content.length) {
      const byte = content[position]!;
      if (byte === elementByte) {
        finishElement(position);
        startElement(position + 1);
        position += 1;
        continue;
      }
      if (byte === repetitionByte) {
        finishComponent(position);
        finishRepetition();
        componentStart = position + 1;
        position += 1;
        continue;
      }
      if (byte === componentByte) {
        finishComponent(position);
        componentStart = position + 1;
        position += 1;
        continue;
      }
      if (byte === releaseByte) {
        if (position + 1 >= content.length) {
          throw new EdifactParseError(
            "release byte is not followed by a data byte",
            "release",
            startOffset + position,
          );
        }
        const released = content[position + 1]!;
        if (released <= 0x1f) {
          throw new EdifactParseError(
            "control bytes are not allowed in component data",
            "control-byte",
            startOffset + position + 1,
          );
        }
        componentRawBytes.push(byte, released);
        componentDataBytes.push(released);
        position += 2;
        continue;
      }
      if (byte <= 0x1f) {
        throw new EdifactParseError(
          "control bytes are not allowed inside a segment",
          "control-byte",
          startOffset + position,
        );
      }
      componentRawBytes.push(byte);
      componentDataBytes.push(byte);
      position += 1;
    }

    finishElement(content.length);
  }

  return Object.freeze({
    tag,
    elements: Object.freeze(elements),
    raw: Uint8Array.from([...content, terminator]),
    byteStart: startOffset,
    byteEnd: endOffset,
  });
}

export class EdifactStreamParser {
  private readonly limits: ResolvedLimits;
  private readonly onExchange: ((exchange: Exchange) => void) | undefined;

  private status: "open" | "failed" | "finished" = "open";
  private failure: Error | null = null;
  private state: ParserState = "between";
  private offset = 0;
  private exchangeActive = false;
  private exchangeStartOffset = 0;
  private builder: ExchangeBuilder | null = null;
  private separators: Separators = DEFAULT_SEPARATORS;
  private probeBytes: number[] = [];
  private probeStartOffset = 0;
  private unaBytes: number[] = [];
  private segmentBytes: number[] = [];
  private segmentStartOffset = 0;
  private escapePending = false;
  private currentDeliveries: Exchange[] = [];

  constructor(options: ParserOptions = {}) {
    this.onExchange = options.onExchange;
    this.limits = {
      maxExchangeBytes: options.limits?.maxExchangeBytes ?? DEFAULT_LIMITS.maxExchangeBytes,
      maxSegments: options.limits?.maxSegments ?? DEFAULT_LIMITS.maxSegments,
      maxComponentBytes: options.limits?.maxComponentBytes ?? DEFAULT_LIMITS.maxComponentBytes,
      maxRepetitions: options.limits?.maxRepetitions ?? DEFAULT_LIMITS.maxRepetitions,
    };
    this.validateLimits();
  }

  push(chunk: Uint8Array | string): Exchange[] {
    this.assertOpen();
    this.currentDeliveries = [];
    try {
      const bytes = byteArrayFromChunk(chunk);
      for (const byte of bytes) {
        if (
          this.exchangeActive &&
          this.offset - this.exchangeStartOffset + 1 > this.limits.maxExchangeBytes
        ) {
          this.fail(
            `exchange exceeds the ${this.limits.maxExchangeBytes}-byte limit`,
            "limit-exchange-bytes",
            this.offset,
          );
        }
        this.consumeByte(byte);
        this.offset += 1;
      }
      return this.currentDeliveries;
    } catch (error) {
      this.status = "failed";
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  finish(): void {
    if (this.status === "failed") {
      this.failTerminal();
    }
    if (this.status === "finished") {
      throw new EdifactParseError("parser is already finished", "terminal", this.offset);
    }

    try {
      if (this.state === "una") {
        this.fail("incomplete UNA at end of stream", "finish-una", this.offset);
      }
      if (this.state === "probe") {
        this.fail("incomplete segment at end of stream", "finish-segment", this.offset);
      }
      if (this.state === "post_una") {
        this.fail("UNA at end of stream is not followed by UNB", "finish-una", this.offset);
      }
      if (this.state === "segment") {
        if (this.escapePending) {
          this.fail("release byte at end of stream is not followed by data", "release-eof", this.offset);
        }
        this.fail("unterminated segment at end of stream", "finish-segment", this.offset);
      }
      if (this.builder !== null) {
        this.fail("exchange envelope is not closed by UNZ", "finish-envelope", this.offset);
      }
      this.status = "finished";
    } catch (error) {
      this.status = "failed";
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  private validateLimits(): void {
    const values = [
      ["maxExchangeBytes", this.limits.maxExchangeBytes, 1],
      ["maxSegments", this.limits.maxSegments, 1],
      ["maxComponentBytes", this.limits.maxComponentBytes, 0],
      ["maxRepetitions", this.limits.maxRepetitions, 1],
    ] as const;
    for (const [name, value, minimum] of values) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
      }
    }
  }

  private assertOpen(): void {
    if (this.status === "failed") {
      this.failTerminal();
    }
    if (this.status === "finished") {
      throw new EdifactParseError("cannot push after finish", "terminal", this.offset);
    }
  }

  private failTerminal(): never {
    const previous = this.failure?.message ?? "unknown failure";
    throw new EdifactParseError(
      `parser is in a terminal failed state: ${previous}`,
      "terminal",
      this.offset,
    );
  }

  private fail(message: string, code: string, offset = this.offset): never {
    throw new EdifactParseError(message, code, offset);
  }

  private consumeByte(byte: number): void {
    switch (this.state) {
      case "between":
        this.consumeBetween(byte);
        return;
      case "probe":
        this.consumeProbe(byte);
        return;
      case "una":
        this.consumeUna(byte);
        return;
      case "post_una":
        this.consumePostUna(byte);
        return;
      case "segment":
        this.consumeSegmentByte(byte);
        return;
    }
  }

  private consumeBetween(byte: number): void {
    if (byte === 0x0d || byte === 0x0a) {
      return;
    }
    if (byte <= 0x1f) {
      this.fail("control byte outside a segment", "control-byte", this.offset);
    }
    if (this.exchangeActive && this.builder !== null) {
      this.startSegment(this.offset, this.separators);
      this.consumeSegmentByte(byte);
      return;
    }
    this.probeBytes = [byte];
    this.probeStartOffset = this.offset;
    this.state = "probe";
  }

  private consumeProbe(byte: number): void {
    if (byte <= 0x1f) {
      this.fail("control byte inside a segment tag", "control-byte", this.offset);
    }
    this.probeBytes.push(byte);
    if (this.probeBytes.length < 3) {
      return;
    }

    const bytes = this.probeBytes;
    this.probeBytes = [];
    if (bytes[0] === 0x55 && bytes[1] === 0x4e && bytes[2] === 0x41) {
      this.startExchange(this.probeStartOffset, true, DEFAULT_SEPARATORS);
      this.unaBytes = bytes;
      this.state = "una";
      this.ensureExchangeBytes(this.offset - this.exchangeStartOffset + 1);
      return;
    }

    this.startExchange(this.probeStartOffset, false, DEFAULT_SEPARATORS);
    this.ensureExchangeBytes(this.offset - this.exchangeStartOffset + 1);
    this.startSegment(this.probeStartOffset, DEFAULT_SEPARATORS);
    for (const probeByte of bytes) {
      this.consumeSegmentByte(probeByte);
      if (this.state !== "segment") {
        break;
      }
    }
  }

  private consumeUna(byte: number): void {
    this.unaBytes.push(byte);
    if (this.unaBytes.length < 9) {
      return;
    }
    if (
      this.unaBytes[0] !== 0x55 ||
      this.unaBytes[1] !== 0x4e ||
      this.unaBytes[2] !== 0x41
    ) {
      this.fail("UNA must begin with the three ASCII bytes UNA", "una", this.exchangeStartOffset);
    }
    const separators = separatorsFromBytes(this.unaBytes.slice(3), this.exchangeStartOffset + 3);
    this.separators = separators;
    if (this.builder !== null) {
      this.builder.una = Uint8Array.from(this.unaBytes);
      this.builder.unaPresent = true;
      this.builder.separators = separators;
    }
    this.unaBytes = [];
    this.state = "post_una";
  }

  private consumePostUna(byte: number): void {
    if (byte === 0x0d || byte === 0x0a) {
      return;
    }
    if (byte <= 0x1f) {
      this.fail("control byte after UNA", "control-byte", this.offset);
    }
    this.startSegment(this.offset, this.separators);
    this.consumeSegmentByte(byte);
  }

  private startExchange(startOffset: number, unaPresent: boolean, separators: Separators): void {
    this.exchangeActive = true;
    this.exchangeStartOffset = startOffset;
    this.separators = separators;
    this.builder = {
      startOffset,
      separators,
      unaPresent,
      una: null,
      unb: null,
      unbRef: null,
      mode: null,
      directMessages: [],
      groups: [],
      groupRefs: new Set<string>(),
      messageRefs: new Set<string>(),
      currentGroup: null,
      currentMessage: null,
      segmentCount: 0,
    };
  }

  private startSegment(startOffset: number, separators: Separators): void {
    this.state = "segment";
    this.segmentStartOffset = startOffset;
    this.segmentBytes = [];
    this.escapePending = false;
    this.separators = separators;
  }

  private consumeSegmentByte(byte: number): void {
    const releaseByte = byteOfSeparator(this.separators.release);
    const segmentByte = byteOfSeparator(this.separators.segment);

    if (this.escapePending) {
      if (byte <= 0x1f) {
        this.fail("control bytes are not allowed in component data", "control-byte", this.offset);
      }
      this.escapePending = false;
      this.segmentBytes.push(byte);
      return;
    }

    if (byte === releaseByte) {
      this.escapePending = true;
      this.segmentBytes.push(byte);
      return;
    }

    if (byte === segmentByte) {
      const content = this.segmentBytes;
      this.segmentBytes = [];
      this.escapePending = false;
      this.state = "between";
      this.completeSegment(content, byte, this.segmentStartOffset, this.offset + 1);
      return;
    }

    if (byte <= 0x1f) {
      this.fail("control byte inside a segment", "control-byte", this.offset);
    }
    this.segmentBytes.push(byte);
  }

  private ensureExchangeBytes(size: number): void {
    if (size > this.limits.maxExchangeBytes) {
      this.fail(
        `exchange exceeds the ${this.limits.maxExchangeBytes}-byte limit`,
        "limit-exchange-bytes",
        this.offset,
      );
    }
  }

  private completeSegment(
    content: readonly number[],
    terminator: number,
    startOffset: number,
    endOffset: number,
  ): void {
    const builder = this.builder;
    if (builder === null) {
      this.fail("segment found without an active exchange", "envelope", startOffset);
    }

    builder.segmentCount += 1;
    if (builder.segmentCount > this.limits.maxSegments) {
      this.fail(
        `exchange exceeds the ${this.limits.maxSegments}-segment limit`,
        "limit-segments",
        startOffset,
      );
    }

    const segment = parseSegmentContent(
      content,
      terminator,
      startOffset,
      endOffset,
      builder.separators,
      this.limits,
    );
    this.handleSegment(builder, segment);
  }

  private handleSegment(builder: ExchangeBuilder, segment: Segment): void {
    const tag = segment.tag;

    if (builder.unb === null) {
      if (tag !== "UNB") {
        this.fail(`exchange must begin with UNB, found ${tag}`, "envelope", segment.byteStart);
      }
      const values = serviceShape(segment, 1, "UNB");
      const ref = values[0]!.text;
      if (ref.length === 0) {
        this.fail("UNB exchange ref must not be empty", "service-shape", segment.byteStart);
      }
      builder.unb = segment;
      builder.unbRef = ref;
      return;
    }

    if (builder.currentMessage !== null) {
      this.handleMessageSegment(builder, builder.currentMessage, segment);
      return;
    }

    if (builder.currentGroup !== null) {
      this.handleGroupSegment(builder, builder.currentGroup, segment);
      return;
    }

    if (tag === "UNH") {
      if (builder.mode === "group") {
        this.fail("UNH cannot appear in group mode outside a group", "envelope", segment.byteStart);
      }
      builder.mode = "direct";
      this.openMessage(builder, segment);
      return;
    }

    if (tag === "UNG") {
      if (builder.mode === "direct") {
        this.fail(
          "an exchange cannot mix direct messages and groups",
          "envelope",
          segment.byteStart,
        );
      }
      if (segment.elements.length !== 1) {
        this.fail("UNG must contain exactly one element", "service-shape", segment.byteStart);
      }
      const ref = scalarText(segment, 0, "UNG group ref");
      if (builder.groupRefs.has(ref)) {
        this.fail(`duplicate group ref ${ref}`, "ref", segment.byteStart);
      }
      builder.groupRefs.add(ref);
      builder.mode = "group";
      builder.currentGroup = { ung: segment, messages: [], ref };
      return;
    }

    if (tag === "UNZ") {
      this.closeExchange(builder, segment);
      return;
    }

    if (isServiceTag(tag)) {
      this.fail(
        `service segment ${tag} is not allowed at this position`,
        "envelope",
        segment.byteStart,
      );
    }
    this.fail(
      `business segment ${tag} can only appear inside a message`,
      "envelope",
      segment.byteStart,
    );
  }

  private openMessage(builder: ExchangeBuilder, segment: Segment): void {
    const values = serviceShape(segment, 2, "UNH");
    const ref = values[0]!.text;
    const type = values[1]!.text;
    if (ref.length === 0) {
      this.fail("UNH message ref must not be empty", "service-shape", segment.byteStart);
    }
    if (type.length === 0) {
      this.fail("UNH message type must not be empty", "service-shape", segment.byteStart);
    }
    if (builder.messageRefs.has(ref)) {
      this.fail(`duplicate message ref ${ref} in exchange`, "ref", segment.byteStart);
    }
    builder.messageRefs.add(ref);
    builder.currentMessage = {
      unh: segment,
      body: [],
      ref,
      type,
      segmentCount: 1,
    };
  }

  private handleMessageSegment(
    builder: ExchangeBuilder,
    message: MessageBuilder,
    segment: Segment,
  ): void {
    const tag = segment.tag;
    message.segmentCount += 1;

    if (tag === "UNT") {
      const values = serviceShape(segment, 2, "UNT");
      const declared = values[0]!.text;
      const ref = values[1]!.text;
      if (!COUNT_PATTERN.test(declared)) {
        this.fail(
          "UNT segment count must be a non-negative decimal integer without leading zeros",
          "count",
          segment.byteStart,
        );
      }
      compareCount(declared, message.segmentCount, segment.byteStart, "UNT");
      if (ref !== message.ref) {
        this.fail(
          `UNT message ref ${ref} does not match UNH ref ${message.ref}`,
          "ref",
          segment.byteStart,
        );
      }
      const closed: Message = Object.freeze({
        unh: message.unh,
        body: Object.freeze(message.body.slice()),
        unt: segment,
        ref: message.ref,
        type: message.type,
        segmentCount: message.segmentCount,
      });
      if (builder.currentGroup !== null) {
        builder.currentGroup.messages.push(closed);
      } else {
        builder.directMessages.push(closed);
      }
      builder.currentMessage = null;
      return;
    }

    if (isServiceTag(tag)) {
      this.fail(
        `service segment ${tag} cannot appear inside a message`,
        "envelope",
        segment.byteStart,
      );
    }
    message.body.push(segment);
  }

  private handleGroupSegment(
    builder: ExchangeBuilder,
    group: GroupBuilder,
    segment: Segment,
  ): void {
    const tag = segment.tag;

    if (tag === "UNH") {
      this.openMessage(builder, segment);
      return;
    }

    if (tag === "UNE") {
      const values = serviceShape(segment, 2, "UNE");
      const declared = values[0]!.text;
      const ref = values[1]!.text;
      if (!COUNT_PATTERN.test(declared)) {
        this.fail(
          "UNE count must be a non-negative decimal integer without leading zeros",
          "count",
          segment.byteStart,
        );
      }
      compareCount(declared, group.messages.length, segment.byteStart, "UNE");
      if (ref !== group.ref) {
        this.fail(
          `UNE group ref ${ref} does not match UNG ref ${group.ref}`,
          "ref",
          segment.byteStart,
        );
      }
      const closed: Group = Object.freeze({
        ung: group.ung,
        messages: Object.freeze(group.messages.slice()),
        une: segment,
        ref: group.ref,
        count: group.messages.length,
      });
      builder.groups.push(closed);
      builder.currentGroup = null;
      return;
    }

    if (tag === "UNG") {
      this.fail("groups cannot be nested", "envelope", segment.byteStart);
    }
    if (tag === "UNZ") {
      this.fail(
        "UNZ cannot appear before UNE closes the current group",
        "envelope",
        segment.byteStart,
      );
    }
    if (isServiceTag(tag)) {
      this.fail(
        `service segment ${tag} is not allowed in an open group`,
        "envelope",
        segment.byteStart,
      );
    }
    this.fail(
      `business segment ${tag} can only appear inside a message`,
      "envelope",
      segment.byteStart,
    );
  }

  private closeExchange(builder: ExchangeBuilder, unz: Segment): void {
    const values = serviceShape(unz, 2, "UNZ");
    const declared = values[0]!.text;
    const ref = values[1]!.text;
    if (!COUNT_PATTERN.test(declared)) {
      this.fail(
        "UNZ count must be a non-negative decimal integer without leading zeros",
        "count",
        unz.byteStart,
      );
    }
    if (builder.unbRef === null) {
      this.fail("UNZ encountered before UNB", "envelope", unz.byteStart);
    }
    if (ref !== builder.unbRef) {
      this.fail(
        `UNZ exchange ref ${ref} does not match UNB ref ${builder.unbRef}`,
        "ref",
        unz.byteStart,
      );
    }

    const mode: ExchangeMode = builder.mode ?? "direct";
    const actualCount = mode === "group" ? builder.groups.length : builder.directMessages.length;
    compareCount(declared, actualCount, unz.byteStart, "UNZ");

    const exchange: Exchange = Object.freeze({
      unaPresent: builder.unaPresent,
      una: builder.una,
      separators: builder.separators,
      unb: builder.unb!,
      unbRef: builder.unbRef,
      mode,
      directMessages: mode === "direct" ? Object.freeze(builder.directMessages.slice()) : null,
      groups: mode === "group" ? Object.freeze(builder.groups.slice()) : null,
      unz,
      count: actualCount,
      byteStart: builder.startOffset,
      byteEnd: unz.byteEnd,
    });

    this.builder = null;
    this.exchangeActive = false;
    this.currentDeliveries.push(exchange);
    if (this.onExchange !== undefined) {
      this.onExchange(exchange);
    }
  }
}
