import { RespProtocolError } from "./errors.js";
import {
  resolveLimits,
  type DecoderLimitOverrides,
  type DecoderLimits,
} from "./limits.js";
import type {
  AttributePair,
  DecodedMessage,
  MapEntry,
  PushMessage,
  RespValue,
  TruncationReason,
} from "./types.js";

/**
 * An independent, whole-buffer reference parser. It intentionally does not
 * share the incremental decoder's parser or state. It is intended for tests
 * and fixture verification, not as the streaming host API.
 */

const CR = 13;
const LF = 10;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class ReferenceTruncation extends Error {
  readonly reason: TruncationReason;
  readonly at: number;
  readonly openContainers: number;
  readonly pendingAttributes: boolean;

  constructor(
    reason: TruncationReason,
    at: number,
    openContainers: number,
    pendingAttributes: boolean,
    detail: string,
  ) {
    super(detail);
    this.name = "ReferenceTruncation";
    this.reason = reason;
    this.at = at;
    this.openContainers = openContainers;
    this.pendingAttributes = pendingAttributes;
  }
}

class RefInput {
  readonly data: Uint8Array;
  readonly owner: RefParser;
  i = 0;

  constructor(data: Uint8Array, owner: RefParser) {
    this.data = data;
    this.owner = owner;
  }

  byte(reason: TruncationReason, detail: string): number {
    if (this.i >= this.data.length) {
      this.owner.truncated(reason, detail);
    }
    return this.data[this.i++]!;
  }

  line(reason: TruncationReason, detail: string): Uint8Array {
    const contentStart = this.i;
    const prefixIndex = contentStart - 1;
    let cursor = contentStart;
    while (cursor < this.data.length) {
      const current = this.data[cursor]!;
      if (current === LF) {
        this.owner.protocol(
          "stray-crlf",
          "bare LF in a header line",
          cursor,
        );
      }
      if (current === CR) {
        if (cursor + 1 >= this.data.length) {
          this.owner.truncated(reason, detail);
        }
        if (this.data[cursor + 1] !== LF) {
          this.owner.protocol(
            "stray-crlf",
            "CR in a header line is not followed by LF",
            cursor,
          );
        }
        if (cursor - prefixIndex > this.owner.limits.maxHeaderBytes) {
          this.owner.protocol(
            "limit-header",
            "header line exceeds maxHeaderBytes",
            prefixIndex,
          );
        }
        const value = this.data.slice(contentStart, cursor);
        this.i = cursor + 2;
        return value;
      }
      if (cursor - prefixIndex + 1 > this.owner.limits.maxHeaderBytes) {
        this.owner.protocol(
          "limit-header",
          "header line exceeds maxHeaderBytes",
          prefixIndex,
        );
      }
      cursor += 1;
    }
    this.owner.truncated(reason, detail);
  }

  exact(n: number, reason: TruncationReason, detail: string): Uint8Array {
    if (this.data.length - this.i < n) {
      this.owner.truncated(reason, detail);
    }
    const result = this.data.slice(this.i, this.i + n);
    this.i += n;
    return result;
  }

  crlf(reason: TruncationReason, detail: string, code: "stray-crlf" | "invalid-null" | "invalid-blob-terminator"): void {
    if (this.i >= this.data.length) {
      this.owner.truncated(reason, detail);
    }
    if (this.data[this.i] !== CR) {
      this.owner.protocol(code, "expected CRLF", this.i);
    }
    if (this.i + 1 >= this.data.length) {
      this.owner.truncated(reason, detail);
    }
    if (this.data[this.i + 1] !== LF) {
      this.owner.protocol(code, "expected CRLF", this.i + 1);
    }
    this.i += 2;
  }
}

class RefParser {
  readonly limits: DecoderLimits;
  readonly base: number;
  readonly input: RefInput;

  nodeCount = 0;
  attrCount = 0;
  leafCount = 0;
  open = 0;
  pending = false;

  constructor(data: Uint8Array, limits: DecoderLimits, base: number) {
    this.limits = limits;
    this.base = base;
    this.input = new RefInput(data, this);
  }

  offset(local = this.input.i): number {
    return this.base + local;
  }

  truncated(reason: TruncationReason, detail: string): never {
    throw new ReferenceTruncation(
      reason,
      this.offset(),
      this.open,
      this.pending,
      detail,
    );
  }

  protocol(
    code: ConstructorParameters<typeof RespProtocolError>[0],
    message: string,
    local = this.input.i,
  ): never {
    throw new RespProtocolError(code, message, this.offset(local));
  }

  parseMessage(): { message: DecodedMessage; end: number } {
    const attrs: AttributePair[] = [];
    let attrSeen = false;
    while (peekType(this.input) === 0x7c) {
      attrSeen = true;
      collectPairs(attrs, this.parseAttributes(1));
    }
    this.pending = attrSeen;
    if (peekType(this.input) < 0) {
      this.truncated(
        attrSeen ? "orphan-attributes" : "unclosed-container",
        attrSeen
          ? "attributes at EOF have no attached value"
          : "EOF before a value",
      );
    }

    let message: DecodedMessage;
    if (peekType(this.input) === 0x3e) {
      message = this.parsePush(attrs);
    } else {
      const value = this.parseValue(1, attrs);
      message = {
        type: "value",
        value,
        attributes: attrs,
        range: { start: this.base, end: this.offset() },
      };
    }
    this.pending = false;
    return { message, end: this.input.i };
  }

  parseAttributes(ownerDepth: number): AttributePair[] {
    const prefix = this.input.i;
    this.input.byte("partial-header", "attribute prefix");
    const token = this.input.line("partial-header", "attribute header");
    if (singleByte(token, 0x3f)) {
      this.protocol("unsupported-feature", "streaming attributes", prefix);
    }
    const nBig = unsigned(token, this, prefix, "attribute count");
    if (
      BigInt(this.attrCount) + nBig >
      BigInt(this.limits.maxAttributePairs)
    ) {
      this.protocol("limit-attributes", "maxAttributePairs exceeded", prefix);
    }
    reserve(this, nBig * 2n, prefix, "attribute values");
    if (nBig > 0n && ownerDepth + 1 > this.limits.maxDepth) {
      this.protocol("limit-depth", "attribute depth exceeded", prefix);
    }
    const n = safe(nBig, this, prefix, "attribute count");
    this.attrCount += n;

    this.open += 1;
    const pairs: AttributePair[] = [];
    for (let index = 0; index < n; index += 1) {
      const key = this.parseAttributed(
        ownerDepth + 1,
        "unclosed-container",
        "attribute key at EOF",
      );
      const value = this.parseAttributed(
        ownerDepth + 1,
        "unclosed-container",
        "attribute value at EOF",
      );
      pairs.push({ key, value });
    }
    this.open -= 1;
    return pairs;
  }

  parseAttributed(
    depth: number,
    reason: TruncationReason,
    detail: string,
  ): RespValue {
    const attrs: AttributePair[] = [];
    let seen = false;
    while (peekType(this.input) === 0x7c) {
      seen = true;
      collectPairs(attrs, this.parseAttributes(depth));
    }
    this.pending = seen;
    if (peekType(this.input) < 0) {
      this.truncated(
        seen ? "orphan-attributes" : reason,
        seen ? "attributes at EOF have no attached value" : detail,
      );
    }
    const result = this.parseValue(depth, attrs);
    this.pending = false;
    return result;
  }

  parseValue(depth: number, attrs: AttributePair[]): RespValue {
    if (depth > this.limits.maxDepth) {
      this.protocol("limit-depth", "maxDepth exceeded", this.input.i);
    }
    const prefix = this.input.i;
    const kind = this.input.byte(
      "unclosed-container",
      "container waiting for a value at EOF",
    );
    switch (kind) {
      case 0x2b:
      case 0x2d: {
        node(this, depth, prefix);
        const payload = this.input.line(
          "partial-header",
          "simple value line",
        );
        leaf(this, payload.length, prefix);
        return kind === 0x2b
          ? { type: "simple-string", value: payload, attributes: attrs }
          : { type: "simple-error", value: payload, attributes: attrs };
      }
      case 0x3a: {
        node(this, depth, prefix);
        const token = this.input.line("partial-header", "integer line");
        return {
          type: "integer",
          value: integer(token, this, prefix),
          attributes: attrs,
        };
      }
      case 0x5f: {
        node(this, depth, prefix);
        this.input.crlf("partial-header", "null line", "invalid-null");
        return { type: "null", attributes: attrs };
      }
      case 0x24: {
        node(this, depth, prefix);
        return this.parseBlob(attrs, prefix);
      }
      case 0x2a: {
        node(this, depth, prefix);
        return this.parseArray(depth, attrs, prefix);
      }
      case 0x25: {
        node(this, depth, prefix);
        return this.parseMap(depth, attrs, prefix);
      }
      case 0x3e:
        this.protocol("nested-push", "nested push", prefix);
      case 0x2e:
        this.protocol("invalid-marker", "unexpected '.'", prefix);
      case 0x3b:
        this.protocol("invalid-context", "unexpected ';'", prefix);
      case 0x7c:
        this.protocol("invalid-context", "unexpected attribute here", prefix);
      default:
        this.protocol(
          "unsupported-type",
          `unsupported type byte 0x${kind.toString(16)}`,
          prefix,
        );
    }
  }

  parseBlob(attrs: AttributePair[], prefix: number): RespValue {
    const token = this.input.line("partial-header", "blob length line");
    if (singleByte(token, 0x3f)) {
      const chunks: Uint8Array[] = [];
      while (true) {
        const marker = this.input.i;
        const byte = this.input.byte(
          "partial-blob",
          "streaming blob chunk header at EOF",
        );
        if (byte !== 0x3b) {
          this.protocol("invalid-context", "expected ';'", marker);
        }
        const chunkToken = this.input.line(
          "partial-header",
          "streaming blob chunk line",
        );
        const nBig = unsigned(chunkToken, this, marker, "blob chunk length");
        if (nBig === 0n) {
          return {
            type: "blob",
            chunks,
            value: join(chunks),
            attributes: attrs,
          };
        }
        reserveLeaf(this, nBig, marker);
        const n = safe(nBig, this, marker, "blob chunk length");
        const chunk = this.input.exact(
          n,
          "partial-blob",
          "streaming blob chunk payload at EOF",
        );
        this.input.crlf(
          "partial-blob",
          "streaming blob chunk CRLF at EOF",
          "invalid-blob-terminator",
        );
        this.leafCount += n;
        chunks.push(chunk);
      }
    }

    const nBig = unsigned(token, this, prefix, "blob length");
    reserveLeaf(this, nBig, prefix);
    const n = safe(nBig, this, prefix, "blob length");
    const bytes = this.input.exact(
      n,
      "partial-blob",
      "blob payload at EOF",
    );
    this.input.crlf(
      "partial-blob",
      "blob CRLF at EOF",
      "invalid-blob-terminator",
    );
    this.leafCount += n;
    return { type: "blob", chunks: [bytes], value: bytes, attributes: attrs };
  }

  parseArray(
    depth: number,
    attrs: AttributePair[],
    prefix: number,
  ): RespValue {
    const token = this.input.line("partial-header", "array line");
    const values: RespValue[] = [];
    if (singleByte(token, 0x3f)) {
      this.open += 1;
      while (true) {
        const next = peekType(this.input);
        if (next < 0) {
          this.truncated("unclosed-container", "streaming array at EOF");
        }
        if (next === 0x2e) {
          this.streamEnd();
          break;
        }
        values.push(
          this.parseAttributed(
            depth + 1,
            "unclosed-container",
            "streaming array item",
          ),
        );
      }
      this.open -= 1;
      return { type: "array", value: values, attributes: attrs };
    }
    const nBig = unsigned(token, this, prefix, "array count");
    reserve(this, nBig, prefix, "array items");
    if (nBig > 0n && depth + 1 > this.limits.maxDepth) {
      this.protocol("limit-depth", "array depth exceeded", prefix);
    }
    const n = safe(nBig, this, prefix, "array count");
    this.open += 1;
    for (let index = 0; index < n; index += 1) {
      values.push(
        this.parseAttributed(
          depth + 1,
          "unclosed-container",
          "fixed array at EOF",
        ),
      );
    }
    this.open -= 1;
    return { type: "array", value: values, attributes: attrs };
  }

  parseMap(
    depth: number,
    attrs: AttributePair[],
    prefix: number,
  ): RespValue {
    const token = this.input.line("partial-header", "map line");
    const pairs: MapEntry[] = [];
    if (singleByte(token, 0x3f)) {
      this.open += 1;
      while (true) {
        const next = peekType(this.input);
        if (next < 0) {
          this.truncated("unclosed-container", "streaming map at EOF");
        }
        if (next === 0x2e) {
          this.streamEnd();
          break;
        }
        const key = this.parseAttributed(
          depth + 1,
          "unclosed-container",
          "streaming map key",
        );
        if (peekType(this.input) === 0x2e) {
          this.protocol(
            "map-odd",
            "streaming map has a key without a value",
            this.input.i,
          );
        }
        const value = this.parseAttributed(
          depth + 1,
          "unclosed-container",
          "streaming map value",
        );
        pairs.push({ key, value });
      }
      this.open -= 1;
      return { type: "map", value: pairs, attributes: attrs };
    }
    const nBig = unsigned(token, this, prefix, "map pair count");
    reserve(this, nBig * 2n, prefix, "map entries");
    if (nBig > 0n && depth + 1 > this.limits.maxDepth) {
      this.protocol("limit-depth", "map depth exceeded", prefix);
    }
    const n = safe(nBig, this, prefix, "map pair count");
    this.open += 1;
    for (let index = 0; index < n; index += 1) {
      const key = this.parseAttributed(
        depth + 1,
        "unclosed-container",
        "fixed map key at EOF",
      );
      const value = this.parseAttributed(
        depth + 1,
        "unclosed-container",
        "fixed map value at EOF",
      );
      pairs.push({ key, value });
    }
    this.open -= 1;
    return { type: "map", value: pairs, attributes: attrs };
  }

  parsePush(attrs: AttributePair[]): PushMessage {
    const prefix = this.input.i;
    this.input.byte("partial-header", "push prefix");
    const token = this.input.line("partial-header", "push line");
    if (singleByte(token, 0x3f)) {
      this.protocol("unsupported-feature", "streaming push", prefix);
    }
    node(this, 1, prefix);
    const nBig = unsigned(token, this, prefix, "push count");
    if (nBig === 0n) {
      this.protocol("invalid-length", "empty push", prefix);
    }
    reserve(this, nBig, prefix, "push values");
    if (2 > this.limits.maxDepth) {
      this.protocol("limit-depth", "push payload depth exceeded", prefix);
    }
    const n = safe(nBig, this, prefix, "push count");
    this.open += 1;
    const values: RespValue[] = [];
    for (let index = 0; index < n; index += 1) {
      values.push(
        this.parseAttributed(
          2,
          "unclosed-container",
          "push payload at EOF",
        ),
      );
    }
    this.open -= 1;
    return {
      type: "push",
      attributes: attrs,
      values,
      range: { start: this.base, end: this.offset() },
    };
  }

  streamEnd(): void {
    const at = this.input.i;
    this.input.byte("partial-header", "stream end at EOF");
    const rest = this.input.line("partial-header", "stream end line");
    if (rest.length !== 0) {
      this.protocol("invalid-marker", "'.' must be alone", at);
    }
  }
}

export interface ReferenceResult {
  messages: DecodedMessage[];
  clean: true;
}

export function decodeReference(
  bytes: Uint8Array,
  overrides: DecoderLimitOverrides = {},
): ReferenceResult {
  const limits = resolveLimits(overrides);
  const messages: DecodedMessage[] = [];
  let position = 0;
  while (position < bytes.length) {
    const parser = new RefParser(bytes.subarray(position), limits, position);
    const result = parser.parseMessage();
    messages.push(result.message);
    if (result.end <= 0) {
      throw new Error("reference parser made no progress");
    }
    position += result.end;
  }
  return { messages, clean: true };
}

function peekType(input: RefInput): number {
  return input.i < input.data.length ? input.data[input.i]! : -1;
}

function collectPairs(target: AttributePair[], source: AttributePair[]): void {
  for (const pair of source) {
    target.push(pair);
  }
}

function singleByte(bytes: Uint8Array, expected: number): boolean {
  return bytes.length === 1 && bytes[0] === expected;
}

function node(parser: RefParser, depth: number, offset: number): void {
  if (depth > parser.limits.maxDepth) {
    parser.protocol("limit-depth", "maxDepth exceeded", offset);
  }
  parser.nodeCount += 1;
  if (parser.nodeCount > parser.limits.maxMessageNodes) {
    parser.protocol("limit-nodes", "maxMessageNodes exceeded", offset);
  }
}

function reserve(
  parser: RefParser,
  amount: bigint,
  offset: number,
  what: string,
): void {
  if (BigInt(parser.nodeCount) + amount > BigInt(parser.limits.maxMessageNodes)) {
    parser.protocol("limit-nodes", `${what} exceed maxMessageNodes`, offset);
  }
}

function reserveLeaf(parser: RefParser, amount: bigint, offset: number): void {
  if (BigInt(parser.leafCount) + amount > BigInt(parser.limits.maxLeafBytes)) {
    parser.protocol("limit-leaf", "maxLeafBytes exceeded", offset);
  }
}

function leaf(parser: RefParser, amount: number, offset: number): void {
  reserveLeaf(parser, BigInt(amount), offset);
  parser.leafCount += amount;
}

function unsigned(
  token: Uint8Array,
  parser: RefParser,
  offset: number,
  what: string,
): bigint {
  if (token.length === 0) {
    parser.protocol("invalid-length", `${what} is empty`, offset);
  }
  if (token[0] === 0x30 && token.length > 1) {
    parser.protocol("invalid-length", `${what} has a leading zero`, offset);
  }
  if (
    !(token[0] === 0x30 || (token[0]! >= 0x31 && token[0]! <= 0x39))
  ) {
    parser.protocol("invalid-length", `${what} is not unsigned`, offset);
  }
  let value = 0n;
  for (const byte of token) {
    if (byte < 0x30 || byte > 0x39) {
      parser.protocol("invalid-length", `${what} has a non-digit`, offset);
    }
    value = value * 10n + BigInt(byte - 0x30);
  }
  return value;
}

function safe(
  value: bigint,
  parser: RefParser,
  offset: number,
  what: string,
): number {
  if (value > MAX_SAFE) {
    parser.protocol("invalid-length", `${what} is unsafe`, offset);
  }
  return Number(value);
}

function integer(token: Uint8Array, parser: RefParser, offset: number): bigint {
  if (token.length === 0) {
    parser.protocol("invalid-integer", "empty integer", offset);
  }
  let index = 0;
  let negative = false;
  if (token[0] === 0x2d) {
    negative = true;
    index = 1;
    if (index === token.length) {
      parser.protocol("invalid-integer", "sign without digits", offset);
    }
  }
  if (token[index] === 0x30) {
    if (token.length - index !== 1) {
      parser.protocol("invalid-integer", "leading zero", offset);
    }
  } else if (token[index]! < 0x31 || token[index]! > 0x39) {
    parser.protocol("invalid-integer", "non-digit integer", offset);
  }
  let magnitude = 0n;
  for (let cursor = index; cursor < token.length; cursor += 1) {
    const byte = token[cursor]!;
    if (byte < 0x30 || byte > 0x39) {
      parser.protocol("invalid-integer", "non-digit integer", offset);
    }
    magnitude = magnitude * 10n + BigInt(byte - 0x30);
  }
  if (negative) {
    if (magnitude === 0n) {
      parser.protocol("invalid-integer", "-0 rejected", offset);
    }
    const value = -magnitude;
    if (value < -9_223_372_036_854_775_808n) {
      parser.protocol("invalid-integer", "below int64", offset);
    }
    return value;
  }
  if (magnitude > 9_223_372_036_854_775_807n) {
    parser.protocol("invalid-integer", "above int64", offset);
  }
  return magnitude;
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return bytes;
}
