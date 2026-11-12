import assert from "node:assert/strict";
import {
  Decoder,
  decodeReference,
  type DecodedMessage,
  type DecoderLimitOverrides,
  type FinishResult,
  type PushMessage,
  type TruncatedFinish,
  type ValueMessage,
} from "../index.js";

export const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function text(value: Uint8Array): string {
  return decoder.decode(value);
}

export function bytes(...parts: Array<string | Uint8Array>): Uint8Array {
  const encoded = parts.map((part) =>
    typeof part === "string" ? encoder.encode(part) : part,
  );
  let length = 0;
  for (const part of encoded) {
    length += part.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of encoded) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function drain(decoder: Decoder, target: DecodedMessage[] = []): DecodedMessage[] {
  while (true) {
    const message = decoder.next();
    if (message === null) {
      return target;
    }
    target.push(message);
  }
}

export function asValueMessage(
  message: DecodedMessage | null,
): ValueMessage {
  if (message === null || message.type !== "value") {
    assert.fail("expected a complete value message");
  }
  return message;
}

export function asPushMessage(
  message: DecodedMessage | null,
): PushMessage {
  if (message === null || message.type !== "push") {
    assert.fail("expected a complete push message");
  }
  return message;
}

export function asTruncated(
  result: FinishResult,
): TruncatedFinish {
  if (result.clean) {
    assert.fail("expected a truncated finish");
  }
  return result;
}

export function decodeInChunks(
  input: Uint8Array,
  chunks: readonly number[],
  limits: DecoderLimitOverrides = {},
): DecodedMessage[] {
  const decoder = new Decoder(limits);
  const messages: DecodedMessage[] = [];
  let offset = 0;
  for (const size of chunks) {
    const end = Math.min(input.length, offset + size);
    decoder.pushBytes(input.slice(offset, end));
    offset = end;
    drain(decoder, messages);
  }
  if (offset < input.length) {
    decoder.pushBytes(input.slice(offset));
  }
  drain(decoder, messages);
  const finish = decoder.finish();
  assert.equal(finish.clean, true, "expected a clean reference boundary");
  return messages;
}

export function decodeAtEveryBoundary(
  input: Uint8Array,
  limits: DecoderLimitOverrides = {},
): void {
  const reference = decodeReference(input, limits).messages;

  for (let split = 0; split <= input.length; split += 1) {
    const decoder = new Decoder(limits);
    const messages: DecodedMessage[] = [];
    decoder.pushBytes(input.slice(0, split));
    drain(decoder, messages);
    decoder.pushBytes(input.slice(split));
    drain(decoder, messages);
    assert.deepStrictEqual(
      messages,
      reference,
      `two-chunk split at byte ${split}`,
    );
    const finish = decoder.finish();
    assert.equal(finish.clean, true, `split at byte ${split} must finish clean`);
  }

  const bytewise = decodeInChunks(input, Array(input.length).fill(1), limits);
  assert.deepStrictEqual(bytewise, reference, "one-byte chunks");

  for (const pattern of [
    [2, 1, 3, 1, 5, 2],
    [1, 1, 1, 7, 2, 3],
    [3, 4, 2, 6, 1],
  ]) {
    const variants: number[] = [];
    let index = 0;
    while (index < input.length) {
      variants.push(pattern[index % pattern.length]!);
      index += 1;
    }
    const result = decodeInChunks(input, variants, limits);
    assert.deepStrictEqual(
      result,
      reference,
      `chunk pattern ${pattern.join(",")}`,
    );
  }
}
