import {
  RespProtocolError,
  type ProtocolErrorCode,
} from "../errors.js";
import type { DecoderLimits } from "../limits.js";
import type {
  AttributePair,
  BlobValue,
  DecodedMessage,
  MapEntry,
  PushMessage,
  RespValue,
  TruncationReason,
  ValueMessage,
} from "../types.js";

const CR = 0x0d;
const LF = 0x0a;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;

export class NeedMore extends Error {
  readonly reason: TruncationReason;
  readonly at: number;
  readonly openContainers: number;
  readonly pendingAttributes: boolean;
  readonly detail: string;

  constructor(
    reason: TruncationReason,
    at: number,
    openContainers: number,
    pendingAttributes: boolean,
    detail: string,
  ) {
    super(detail);
    this.name = "NeedMore";
    this.reason = reason;
    this.at = at;
    this.openContainers = openContainers;
    this.pendingAttributes = pendingAttributes;
    this.detail = detail;
  }
}

interface ParseOutcome {
  message: DecodedMessage;
  end: number;
}

class Cursor {
  readonly bytes: Uint8Array;
  readonly parser: FrameParser;
  pos = 0;

  constructor(bytes: Uint8Array, parser: FrameParser) {
    this.bytes = bytes;
    this.parser = parser;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  peek(): number {
    return this.pos < this.bytes.length ? this.bytes[this.pos]! : -1;
  }

  readByte(reason: TruncationReason, detail: string): number {
    if (this.pos >= this.bytes.length) {
      this.parser.needMore(reason, detail);
    }
    return this.bytes[this.pos++]!;
  }

  /**
   * Reads bytes through the first CRLF. The type prefix is already consumed;
   * maxHeaderBytes includes that one-byte prefix and excludes the CRLF.
   */
  readLine(reason: TruncationReason, detail: string): Uint8Array {
    const contentStart = this.pos;
    const lineStart = contentStart - 1;
    let i = contentStart;

    while (true) {
      if (i >= this.bytes.length) {
        this.parser.needMore(reason, detail);
      }

      const byte = this.bytes[i]!;
      if (byte === CR) {
        if (i + 1 >= this.bytes.length) {
          this.parser.needMore(reason, detail);
        }
        if (this.bytes[i + 1] !== LF) {
          this.parser.fail(
            "stray-crlf",
            "CR in a header line is not followed by LF",
            i,
          );
        }
        if (i - lineStart > this.parser.limits.maxHeaderBytes) {
          this.parser.fail(
            "limit-header",
            `header line exceeds maxHeaderBytes (${this.parser.limits.maxHeaderBytes})`,
            lineStart,
          );
        }
        const content = this.bytes.slice(contentStart, i);
        this.pos = i + 2;
        return content;
      }

      if (byte === LF) {
        this.parser.fail(
          "stray-crlf",
          "LF in a header line is not preceded by CR",
          i,
        );
      }

      if (i - lineStart + 1 > this.parser.limits.maxHeaderBytes) {
        this.parser.fail(
          "limit-header",
          `header line exceeds maxHeaderBytes (${this.parser.limits.maxHeaderBytes})`,
          lineStart,
        );
      }
      i += 1;
    }
  }

  readExact(length: number, reason: TruncationReason, detail: string): Uint8Array {
    if (this.remaining < length) {
      this.parser.needMore(reason, detail);
    }
    const result = this.bytes.slice(this.pos, this.pos + length);
    this.pos += length;
    return result;
  }

  expectCrlf(
    reason: TruncationReason,
    detail: string,
    code: ProtocolErrorCode,
  ): void {
    if (this.pos >= this.bytes.length) {
      this.parser.needMore(reason, detail);
    }
    if (this.bytes[this.pos] !== CR) {
      this.parser.fail(code, "expected CRLF", this.pos);
    }
    if (this.pos + 1 >= this.bytes.length) {
      this.parser.needMore(reason, detail);
    }
    if (this.bytes[this.pos + 1] !== LF) {
      this.parser.fail(code, "expected CRLF", this.pos + 1);
    }
    this.pos += 2;
  }
}

export class FrameParser {
  readonly limits: DecoderLimits;
  readonly baseOffset: number;
  readonly cursor: Cursor;

  private nodes = 0;
  private attributePairs = 0;
  private leafBytes = 0;
  private openContainers = 0;
  private pendingAttributes = false;

  constructor(
    bytes: Uint8Array,
    limits: DecoderLimits,
    baseOffset: number,
  ) {
    this.limits = limits;
    this.baseOffset = baseOffset;
    this.cursor = new Cursor(bytes, this);
  }

  absolute(relative = this.cursor.pos): number {
    return this.baseOffset + relative;
  }

  needMore(reason: TruncationReason, detail: string): never {
    throw new NeedMore(
      reason,
      this.absolute(this.cursor.bytes.length),
      this.openContainers,
      this.pendingAttributes,
      detail,
    );
  }

  fail(code: ProtocolErrorCode, message: string, relative: number): never {
    throw new RespProtocolError(code, message, this.absolute(relative));
  }

  parseMessage(): ParseOutcome {
    const attributes: AttributePair[] = [];
    let sawAttributeBlock = false;

    while (this.cursor.peek() === 0x7c /* | */) {
      sawAttributeBlock = true;
      this.appendPairs(attributes, this.parseAttributeBlock(1));
    }

    this.pendingAttributes = sawAttributeBlock;
    if (this.cursor.peek() < 0) {
      this.needMore(
        sawAttributeBlock ? "orphan-attributes" : "unclosed-container",
        sawAttributeBlock
          ? "attributes reached EOF without an attached value"
          : "EOF before a top-level value",
      );
    }

    let message: DecodedMessage;
    if (this.cursor.peek() === 0x3e /* > */) {
      message = this.parsePush(attributes);
    } else {
      const value = this.parseValue(1, attributes);
      message = {
        type: "value",
        value,
        attributes,
        range: {
          start: this.baseOffset,
          end: this.absolute(),
        },
      } satisfies ValueMessage;
    }
    this.pendingAttributes = false;

    return { message, end: this.cursor.pos };
  }

  private appendPairs(target: AttributePair[], source: AttributePair[]): void {
    for (const pair of source) {
      target.push(pair);
    }
  }

  private parseAttributeBlock(ownerDepth: number): AttributePair[] {
    const typeOffset = this.cursor.pos;
    this.cursor.readByte("partial-header", "attribute prefix");
    const token = this.cursor.readLine(
      "partial-header",
      "attribute header line",
    );
    if (token.length === 1 && token[0] === 0x3f /* ? */) {
      this.fail(
        "unsupported-feature",
        "streaming attributes (|?) are unsupported",
        typeOffset,
      );
    }
    const countBig = this.parseUnsigned(token, typeOffset, "attribute count");

    if (
      BigInt(this.attributePairs) + countBig >
      BigInt(this.limits.maxAttributePairs)
    ) {
      this.fail(
        "limit-attributes",
        `attribute pairs exceed maxAttributePairs (${this.limits.maxAttributePairs})`,
        typeOffset,
      );
    }

    this.reserveNodes(countBig * 2n, typeOffset, "attribute keys and values");
    if (countBig > 0n && ownerDepth + 1 > this.limits.maxDepth) {
      this.fail(
        "limit-depth",
        `attribute keys/values would exceed maxDepth (${this.limits.maxDepth})`,
        typeOffset,
      );
    }

    this.attributePairs += this.toSafeIndex(
      countBig,
      typeOffset,
      "attribute count",
    );
    const count = this.toSafeIndex(countBig, typeOffset, "attribute count");

    this.openContainers += 1;
    const pairs: AttributePair[] = [];
    for (let pairIndex = 0; pairIndex < count; pairIndex += 1) {
      const key = this.parseAttributedValue(
        ownerDepth + 1,
        "unclosed-container",
        "attribute block reached EOF before a key",
      );
      const value = this.parseAttributedValue(
        ownerDepth + 1,
        "unclosed-container",
        "attribute block reached EOF before a value",
      );
      pairs.push({ key, value });
    }
    this.openContainers -= 1;
    return pairs;
  }

  private parseAttributedValue(
    depth: number,
    noByteReason: TruncationReason,
    noByteDetail: string,
  ): RespValue {
    const attributes: AttributePair[] = [];
    let sawAttributeBlock = false;

    while (this.cursor.peek() === 0x7c /* | */) {
      sawAttributeBlock = true;
      this.appendPairs(attributes, this.parseAttributeBlock(depth));
    }

    this.pendingAttributes = sawAttributeBlock;
    if (this.cursor.peek() < 0) {
      this.needMore(
        sawAttributeBlock ? "orphan-attributes" : noByteReason,
        sawAttributeBlock
          ? "attributes reached EOF without an attached value"
          : noByteDetail,
      );
    }

    const value = this.parseValue(depth, attributes);
    this.pendingAttributes = false;
    return value;
  }

  private parseValue(depth: number, attributes: AttributePair[]): RespValue {
    if (depth > this.limits.maxDepth) {
      this.fail(
        "limit-depth",
        `value depth ${depth} exceeds maxDepth (${this.limits.maxDepth})`,
        this.cursor.pos,
      );
    }

    const typeOffset = this.cursor.pos;
    const typeByte = this.cursor.readByte(
      "unclosed-container",
      "container reached EOF before the next value",
    );

    switch (typeByte) {
      case 0x2b /* + */:
      case 0x2d /* - */: {
        this.addNode(depth, typeOffset);
        const payload = this.cursor.readLine(
          "partial-header",
          "simple string/error header line",
        );
        this.addLeaf(payload.length, typeOffset);
        if (typeByte === 0x2b) {
          return {
            type: "simple-string",
            value: payload,
            attributes,
          };
        }
        return {
          type: "simple-error",
          value: payload,
          attributes,
        };
      }

      case 0x3a /* : */: {
        this.addNode(depth, typeOffset);
        const token = this.cursor.readLine(
          "partial-header",
          "integer header line",
        );
        return {
          type: "integer",
          value: this.parseInteger(token, typeOffset),
          attributes,
        };
      }

      case 0x5f /* _ */: {
        this.addNode(depth, typeOffset);
        this.cursor.expectCrlf(
          "partial-header",
          "null marker line",
          "invalid-null",
        );
        return { type: "null", attributes };
      }

      case 0x24 /* $ */: {
        this.addNode(depth, typeOffset);
        return this.parseBlob(typeOffset, attributes);
      }

      case 0x2a /* * */: {
        this.addNode(depth, typeOffset);
        return this.parseArray(depth, typeOffset, attributes);
      }

      case 0x25 /* % */: {
        this.addNode(depth, typeOffset);
        return this.parseMap(depth, typeOffset, attributes);
      }

      case 0x3e /* > */:
        this.fail("nested-push", "pushes are only allowed at top level", typeOffset);

      case 0x2e /* . */:
        this.fail(
          "invalid-marker",
          "stream terminator '.' is not valid here",
          typeOffset,
        );

      case 0x3b /* ; */:
        this.fail(
          "invalid-context",
          "blob chunk marker ';' is only valid inside a streaming blob",
          typeOffset,
        );

      case 0x7c /* | */:
        this.fail(
          "invalid-context",
          "attribute block does not occupy a value position",
          typeOffset,
        );

      default:
        this.fail(
          "unsupported-type",
          `unsupported RESP type byte 0x${typeByte.toString(16).padStart(2, "0")}`,
          typeOffset,
        );
    }
  }

  private parseBlob(
    typeOffset: number,
    attributes: AttributePair[],
  ): BlobValue {
    const token = this.cursor.readLine(
      "partial-header",
      "blob length header line",
    );
    if (token.length === 1 && token[0] === 0x3f /* ? */) {
      return this.parseStreamingBlob(typeOffset, attributes);
    }

    const lengthBig = this.parseUnsigned(token, typeOffset, "blob length");
    this.reserveLeaf(lengthBig, typeOffset);
    const length = this.toSafeIndex(lengthBig, typeOffset, "blob length");

    const chunk = this.cursor.readExact(
      length,
      "partial-blob",
      `blob payload needs ${length} bytes`,
    );
    this.cursor.expectCrlf(
      "partial-blob",
      "blob payload terminator",
      "invalid-blob-terminator",
    );
    this.leafBytes += length;
    return {
      type: "blob",
      chunks: [chunk],
      value: chunk,
      attributes,
    };
  }

  private parseStreamingBlob(
    typeOffset: number,
    attributes: AttributePair[],
  ): BlobValue {
    const chunks: Uint8Array[] = [];

    while (true) {
      const markerOffset = this.cursor.pos;
      const marker = this.cursor.readByte(
        "partial-blob",
        "streaming blob is missing its next chunk header",
      );
      if (marker !== 0x3b /* ; */) {
        this.fail(
          "invalid-context",
          "streaming blob expected a ';' chunk header",
          markerOffset,
        );
      }

      const token = this.cursor.readLine(
        "partial-header",
        "streaming blob chunk header line",
      );
      const lengthBig = this.parseUnsigned(
        token,
        markerOffset,
        "streaming blob chunk length",
      );
      if (lengthBig === 0n) {
        return {
          type: "blob",
          chunks,
          value: concatenate(chunks),
          attributes,
        };
      }

      this.reserveLeaf(lengthBig, markerOffset);
      const length = this.toSafeIndex(
        lengthBig,
        markerOffset,
        "streaming blob chunk length",
      );
      const chunk = this.cursor.readExact(
        length,
        "partial-blob",
        `streaming blob chunk needs ${length} bytes`,
      );
      this.cursor.expectCrlf(
        "partial-blob",
        "streaming blob chunk terminator",
        "invalid-blob-terminator",
      );
      this.leafBytes += length;
      chunks.push(chunk);
    }
  }

  private parseArray(
    depth: number,
    typeOffset: number,
    attributes: AttributePair[],
  ): RespValue {
    const token = this.cursor.readLine(
      "partial-header",
      "array count header line",
    );
    const values: RespValue[] = [];

    if (token.length === 1 && token[0] === 0x3f /* ? */) {
      this.openContainers += 1;
      while (true) {
        const next = this.cursor.peek();
        if (next < 0) {
          this.needMore(
            "unclosed-container",
            "streaming array reached EOF before '.'",
          );
        }
        if (next === 0x2e /* . */) {
          this.consumeStreamEnd();
          break;
        }
        values.push(
          this.parseAttributedValue(
            depth + 1,
            "unclosed-container",
            "streaming array element",
          ),
        );
      }
      this.openContainers -= 1;
      return { type: "array", value: values, attributes };
    }

    const countBig = this.parseUnsigned(token, typeOffset, "array count");
    this.reserveNodes(countBig, typeOffset, "array elements");
    if (countBig > 0n && depth + 1 > this.limits.maxDepth) {
      this.fail(
        "limit-depth",
        `array elements would exceed maxDepth (${this.limits.maxDepth})`,
        typeOffset,
      );
    }
    const count = this.toSafeIndex(countBig, typeOffset, "array count");

    this.openContainers += 1;
    for (let index = 0; index < count; index += 1) {
      values.push(
        this.parseAttributedValue(
          depth + 1,
          "unclosed-container",
          "fixed array reached EOF before all elements",
        ),
      );
    }
    this.openContainers -= 1;
    return { type: "array", value: values, attributes };
  }

  private parseMap(
    depth: number,
    typeOffset: number,
    attributes: AttributePair[],
  ): RespValue {
    const token = this.cursor.readLine(
      "partial-header",
      "map count header line",
    );
    const entries: MapEntry[] = [];

    if (token.length === 1 && token[0] === 0x3f /* ? */) {
      this.openContainers += 1;
      while (true) {
        const next = this.cursor.peek();
        if (next < 0) {
          this.needMore(
            "unclosed-container",
            "streaming map reached EOF before '.'",
          );
        }
        if (next === 0x2e /* . */) {
          this.consumeStreamEnd();
          break;
        }

        const key = this.parseAttributedValue(
          depth + 1,
          "unclosed-container",
          "streaming map key",
        );
        const valueStart = this.cursor.pos;
        if (this.cursor.peek() === 0x2e /* . */) {
          this.fail(
            "map-odd",
            "streaming map ended after a key without its value",
            valueStart,
          );
        }
        const value = this.parseAttributedValue(
          depth + 1,
          "unclosed-container",
          "streaming map value",
        );
        entries.push({ key, value });
      }
      this.openContainers -= 1;
      return { type: "map", value: entries, attributes };
    }

    const countBig = this.parseUnsigned(token, typeOffset, "map pair count");
    this.reserveNodes(countBig * 2n, typeOffset, "map keys and values");
    if (countBig > 0n && depth + 1 > this.limits.maxDepth) {
      this.fail(
        "limit-depth",
        `map keys/values would exceed maxDepth (${this.limits.maxDepth})`,
        typeOffset,
      );
    }
    const count = this.toSafeIndex(countBig, typeOffset, "map pair count");

    this.openContainers += 1;
    for (let index = 0; index < count; index += 1) {
      const key = this.parseAttributedValue(
        depth + 1,
        "unclosed-container",
        "fixed map reached EOF before a key",
      );
      const value = this.parseAttributedValue(
        depth + 1,
        "unclosed-container",
        "fixed map reached EOF before a value",
      );
      entries.push({ key, value });
    }
    this.openContainers -= 1;
    return { type: "map", value: entries, attributes };
  }

  private parsePush(attributes: AttributePair[]): PushMessage {
    const typeOffset = this.cursor.pos;
    if (this.openContainers > 0) {
      this.fail("nested-push", "pushes are only allowed at top level", typeOffset);
    }
    this.cursor.readByte("partial-header", "push prefix");
    const token = this.cursor.readLine("partial-header", "push count header line");
    if (token.length === 1 && token[0] === 0x3f /* ? */) {
      this.fail(
        "unsupported-feature",
        "streaming pushes (>?) are unsupported",
        typeOffset,
      );
    }

    this.addNode(1, typeOffset);
    const countBig = this.parseUnsigned(token, typeOffset, "push element count");
    if (countBig === 0n) {
      this.fail("invalid-length", "a push must contain at least one value", typeOffset);
    }
    this.reserveNodes(countBig, typeOffset, "push payload values");
    this.failIfChildrenTooDeep(1, typeOffset, "push payload");
    const count = this.toSafeIndex(countBig, typeOffset, "push element count");

    this.openContainers += 1;
    const values: RespValue[] = [];
    for (let index = 0; index < count; index += 1) {
      values.push(
        this.parseAttributedValue(
          2,
          "unclosed-container",
          "push reached EOF before all payload values",
        ),
      );
    }
    this.openContainers -= 1;

    return {
      type: "push",
      attributes,
      values,
      range: {
        start: this.baseOffset,
        end: this.absolute(),
      },
    };
  }

  private consumeStreamEnd(): void {
    const offset = this.cursor.pos;
    this.cursor.readByte("partial-header", "stream terminator");
    const token = this.cursor.readLine("partial-header", "stream terminator line");
    if (token.length !== 0) {
      this.fail(
        "invalid-marker",
        "stream terminator '.' must be followed immediately by CRLF",
        offset,
      );
    }
  }

  private addNode(depth: number, offset: number): void {
    if (depth > this.limits.maxDepth) {
      this.fail(
        "limit-depth",
        `value depth ${depth} exceeds maxDepth (${this.limits.maxDepth})`,
        offset,
      );
    }
    this.nodes += 1;
    if (this.nodes > this.limits.maxMessageNodes) {
      this.fail(
        "limit-nodes",
        `message values exceed maxMessageNodes (${this.limits.maxMessageNodes})`,
        offset,
      );
    }
  }

  private reserveNodes(additional: bigint, offset: number, what: string): void {
    if (
      BigInt(this.nodes) + additional >
      BigInt(this.limits.maxMessageNodes)
    ) {
      this.fail(
        "limit-nodes",
        `${what} exceed maxMessageNodes (${this.limits.maxMessageNodes})`,
        offset,
      );
    }
  }

  private failIfChildrenTooDeep(
    parentDepth: number,
    offset: number,
    what: string,
  ): void {
    if (parentDepth + 1 > this.limits.maxDepth) {
      this.fail(
        "limit-depth",
        `${what} would exceed maxDepth (${this.limits.maxDepth})`,
        offset,
      );
    }
  }

  private reserveLeaf(additional: bigint, offset: number): void {
    if (
      BigInt(this.leafBytes) + additional >
      BigInt(this.limits.maxLeafBytes)
    ) {
      this.fail(
        "limit-leaf",
        `leaf bytes exceed maxLeafBytes (${this.limits.maxLeafBytes})`,
        offset,
      );
    }
  }

  private addLeaf(additional: number, offset: number): void {
    this.reserveLeaf(BigInt(additional), offset);
    this.leafBytes += additional;
  }

  private parseUnsigned(
    token: Uint8Array,
    offset: number,
    what: string,
  ): bigint {
    if (token.length === 0) {
      this.fail("invalid-length", `${what} is empty`, offset);
    }
    if (token[0] === 0x30 /* 0 */) {
      if (token.length !== 1) {
        this.fail(
          "invalid-length",
          `${what} has a leading zero or is not an unsigned decimal`,
          offset,
        );
      }
      return 0n;
    }
    if (token[0]! < 0x31 || token[0]! > 0x39) {
      this.fail(
        "invalid-length",
        `${what} must be an unsigned decimal without a sign`,
        offset,
      );
    }

    let value = 0n;
    for (let index = 0; index < token.length; index += 1) {
      const byte = token[index]!;
      if (byte < 0x30 || byte > 0x39) {
        this.fail(
          "invalid-length",
          `${what} must contain only decimal digits`,
          offset,
        );
      }
      value = value * 10n + BigInt(byte - 0x30);
    }
    return value;
  }

  private toSafeIndex(value: bigint, offset: number, what: string): number {
    if (value > MAX_SAFE_BIGINT) {
      this.fail(
        "invalid-length",
        `${what} exceeds Number.MAX_SAFE_INTEGER`,
        offset,
      );
    }
    return Number(value);
  }

  private parseInteger(token: Uint8Array, offset: number): bigint {
    if (token.length === 0) {
      this.fail("invalid-integer", "integer is empty", offset);
    }

    let index = 0;
    let negative = false;
    if (token[0] === 0x2d /* - */) {
      negative = true;
      index = 1;
      if (index === token.length) {
        this.fail("invalid-integer", "integer sign has no digits", offset);
      }
    }

    if (token[index] === 0x30 /* 0 */) {
      if (token.length - index !== 1) {
        this.fail(
          "invalid-integer",
          "integer has a leading zero or an invalid form",
          offset,
        );
      }
    } else if (token[index]! < 0x31 || token[index]! > 0x39) {
      this.fail(
        "invalid-integer",
        "integer must contain only an optional '-' and decimal digits",
        offset,
      );
    }

    let magnitude = 0n;
    for (let cursor = index; cursor < token.length; cursor += 1) {
      const byte = token[cursor]!;
      if (byte < 0x30 || byte > 0x39) {
        this.fail("invalid-integer", "integer contains a non-digit byte", offset);
      }
      magnitude = magnitude * 10n + BigInt(byte - 0x30);
    }

    if (negative) {
      if (magnitude === 0n) {
        this.fail("invalid-integer", "-0 is not accepted", offset);
      }
      const value = -magnitude;
      if (value < INT64_MIN) {
        this.fail("invalid-integer", "integer is below int64 minimum", offset);
      }
      return value;
    }
    if (magnitude > INT64_MAX) {
      this.fail("invalid-integer", "integer is above int64 maximum", offset);
    }
    return magnitude;
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
