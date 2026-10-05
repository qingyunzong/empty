import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, StreamParser, ParseError, type CanonicalValue, type ParsedValue } from "../src/index.js";

function parseAll(chunks: Uint8Array[]): ParsedValue[] {
  const values: ParsedValue[] = [];
  const parser = new StreamParser((v) => values.push(v));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return values;
}

function parseOne(bytes: Uint8Array): ParsedValue {
  const values = parseAll([bytes]);
  assert.equal(values.length, 1);
  return values[0];
}

test("round-trips nested values", () => {
  const value: CanonicalValue = {
    n: -42,
    big: 2n ** 200n,
    bytes: new Uint8Array([1, 2, 3]),
    list: [0, 7, []],
    empty: {},
    emptyList: [],
  };
  const parsed = parseOne(encode(value));
  assert.deepEqual(parsed, new Map<string, ParsedValue>([
    ["big", 2n ** 200n],
    ["bytes", new Uint8Array([1, 2, 3])],
    ["empty", new Map()],
    ["emptyList", []],
    ["list", [0, 7, []]],
    ["n", -42],
  ]));
});

test("safe integers decode to number, unsafe to bigint", () => {
  assert.equal(parseOne(encode(42)), 42);
  assert.equal(parseOne(encode(2n ** 60n)), 2n ** 60n);
  assert.equal(parseOne(encode(-(2n ** 60n))), -(2n ** 60n));
});

test("streaming byte-by-byte yields values only when complete", () => {
  const bytes = encode({ a: [1, 2], b: new Uint8Array([7, 8, 9]) });
  const values: ParsedValue[] = [];
  const parser = new StreamParser((v) => values.push(v));
  for (let i = 0; i < bytes.length; i++) {
    parser.push(bytes.subarray(i, i + 1));
    assert.equal(values.length, i === bytes.length - 1 ? 1 : 0, `at byte ${i}`);
  }
  assert.equal(parser.offset, bytes.length);
  parser.end();
});

test("multiple top-level values stream in order", () => {
  const bytes = Buffer.concat([encode(1), encode([2]), encode({ a: 3 })]);
  assert.deepEqual(parseAll([bytes]), [1, [2], new Map([["a", 3]])]);
});

test("chunk boundaries may fall anywhere", () => {
  const bytes = encode({ key: [1, -1, new Uint8Array(300).fill(0xab)] });
  for (const cut of [1, 2, 5, 6, 7, 100, bytes.length - 1]) {
    const values = parseAll([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.equal(values.length, 1, `cut at ${cut}`);
  }
});

function expectParseError(bytes: number[], offset: number, pattern: RegExp): void {
  let caught: unknown;
  try {
    parseAll([new Uint8Array(bytes)]);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ParseError, `expected ParseError, got ${caught}`);
  assert.equal((caught as ParseError).offset, offset);
  assert.match((caught as ParseError).message, pattern);
}

test("unknown tag reports its offset", () => {
  expectParseError([0x7f], 0, /unknown tag 0x7f/);
  // After one complete top-level value, the bad tag is at offset 3.
  expectParseError([0x01, 0x01, 0x00, 0x7f], 3, /unknown tag 0x7f/);
});

test("truncated input reports the end offset on end()", () => {
  const parser = new StreamParser(() => {});
  parser.push(new Uint8Array([0x03, 0, 0, 0, 5, 1, 2]));
  assert.throws(() => parser.end(), (err: unknown) => {
    assert.ok(err instanceof ParseError);
    assert.equal((err as ParseError).offset, 7);
    assert.match((err as ParseError).message, /unexpected end of input/);
    return true;
  });
});

test("non-minimal integer is rejected with offset of the leading zero", () => {
  expectParseError([0x01, 0x02, 0x00, 0x01], 2, /non-minimal integer/);
  expectParseError([0x01, 0x00], 1, /zero-length magnitude/);
});

test("string tag outside an object is rejected", () => {
  expectParseError([0x06, 0, 0, 0, 1, 0x61], 0, /only valid as an object key/);
});

// Hand-built object bytes: 05 <count:4> then pairs of (06 <len:4> <utf8>) <value>.
function objectBytes(keys: string[], values: number[][]): number[] {
  const out = [0x05, 0, 0, 0, keys.length];
  keys.forEach((key, i) => {
    const kb = [...Buffer.from(key, "utf8")];
    out.push(0x06, 0, 0, 0, kb.length, ...kb, ...values[i]);
  });
  return out;
}

const INT0 = [0x01, 0x01, 0x00];

test("duplicate keys are rejected at the second key's offset", () => {
  const bytes = objectBytes(["a", "a"], [INT0, INT0]);
  // 5-byte header + (1+4+1) key + 3-byte value = second key tag at offset 14.
  expectParseError(bytes, 14, /duplicate object key/);
});

test("out-of-order keys are rejected at the offending key's offset", () => {
  const bytes = objectBytes(["b", "a"], [INT0, INT0]);
  expectParseError(bytes, 14, /not in canonical order/);
});

test("invalid UTF-8 in a key reports the bad byte's offset", () => {
  // WTF-8 style lone surrogate U+D800: ED A0 80 — invalid UTF-8.
  const bytes = [0x05, 0, 0, 0, 1, 0x06, 0, 0, 0, 3, 0xed, 0xa0, 0x80, ...INT0];
  expectParseError(bytes, 10, /not valid UTF-8/);
  // Overlong encoding of 'a': C1 A1.
  const overlong = [0x05, 0, 0, 0, 1, 0x06, 0, 0, 0, 2, 0xc1, 0xa1, ...INT0];
  expectParseError(overlong, 10, /not valid UTF-8/);
});

test("error offsets are absolute across chunk boundaries", () => {
  const parser = new StreamParser(() => {});
  parser.push(new Uint8Array([0x01, 0x01, 0x00])); // one complete value, 3 bytes consumed
  assert.throws(() => parser.push(new Uint8Array([0xff])), (err: unknown) => {
    assert.ok(err instanceof ParseError);
    assert.equal((err as ParseError).offset, 3);
    return true;
  });
});
