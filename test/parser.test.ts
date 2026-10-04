import test from "node:test";
import assert from "node:assert/strict";
import { Format, FormatError } from "../src/format";
import { ParseError, Parser, compileFormat, parseBuffer } from "../src/parser";

const u8 = (...vals: number[]): Uint8Array => new Uint8Array(vals);

test("length references a previous field", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "n", type: "uint8" },
        { name: "data", type: "bytes", length: { ref: "n" } },
      ],
    },
  };
  const { value, bytesRead } = parseBuffer(format, u8(3, 9, 8, 7));
  assert.equal(value.n, 3);
  assert.deepStrictEqual(value.data, u8(9, 8, 7));
  assert.equal(bytesRead, 4);
});

test("scaled length with offset", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "n", type: "uint8" },
        { name: "data", type: "bytes", length: { ref: "n", scale: 2, offset: 1 } },
      ],
    },
  };
  const { value } = parseBuffer(format, u8(2, 1, 2, 3, 4, 5));
  assert.deepStrictEqual(value.data, u8(1, 2, 3, 4, 5));
});

test("conditional field present and absent", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "tag", type: "uint8" },
        { name: "payload", type: "bytes", length: 2, when: { ref: "tag", eq: 1 } },
      ],
    },
  };
  const present = parseBuffer(format, u8(1, 0xaa, 0xbb));
  assert.deepStrictEqual(present.value.payload, u8(0xaa, 0xbb));
  assert.equal(present.bytesRead, 3);
  const absent = parseBuffer(format, u8(0));
  assert.deepStrictEqual(absent.value, { tag: 0 });
  assert.equal(absent.bytesRead, 1);
});

test("nested arrays", () => {
  const format: Format = {
    root: {
      fields: [
        {
          name: "matrix",
          type: "array",
          count: 2,
          element: { type: "array", count: 2, element: { type: "uint16le" } },
        },
      ],
    },
  };
  const { value } = parseBuffer(format, u8(1, 0, 2, 0, 3, 0, 4, 0));
  assert.deepStrictEqual(value.matrix, [
    [1, 2],
    [3, 4],
  ]);
});

test("array count from a previous field", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "count", type: "uint8" },
        { name: "items", type: "array", count: { ref: "count" }, element: { type: "uint8" } },
      ],
    },
  };
  const { value } = parseBuffer(format, u8(3, 10, 20, 30));
  assert.deepStrictEqual(value.items, [10, 20, 30]);
});

test("array element length references outer field", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "width", type: "uint8" },
        {
          name: "rows",
          type: "array",
          count: 2,
          element: { type: "bytes", length: { ref: "width" } },
        },
      ],
    },
  };
  const { value } = parseBuffer(format, u8(2, 1, 2, 3, 4));
  assert.deepStrictEqual(value.rows, [u8(1, 2), u8(3, 4)]);
});

test("named definitions and ref fields", () => {
  const format: Format = {
    definitions: {
      point: {
        fields: [
          { name: "x", type: "uint8" },
          { name: "y", type: "uint8" },
        ],
      },
    },
    root: {
      fields: [
        { name: "a", type: "ref", ref: "point" },
        { name: "b", type: "ref", ref: "point" },
      ],
    },
  };
  const { value } = parseBuffer(format, u8(1, 2, 3, 4));
  assert.deepStrictEqual(value.a, { x: 1, y: 2 });
  assert.deepStrictEqual(value.b, { x: 3, y: 4 });
});

test("root may name a definition", () => {
  const format: Format = {
    definitions: {
      header: { fields: [{ name: "magic", type: "uint16be" }] },
    },
    root: "header",
  };
  const { value } = parseBuffer(format, u8(0xca, 0xfe));
  assert.equal(value.magic, 0xcafe);
});

test("definition cycle is rejected", () => {
  const format: Format = {
    definitions: {
      a: { fields: [{ name: "b", type: "ref", ref: "b" }] },
      b: { fields: [{ name: "a", type: "ref", ref: "a" }] },
    },
    root: "a",
  };
  assert.throws(() => compileFormat(format), /cycle detected: a -> b -> a/);
});

test("self-recursive definition is rejected", () => {
  const format: Format = {
    definitions: {
      node: { fields: [{ name: "next", type: "ref", ref: "node" }] },
    },
    root: "node",
  };
  assert.throws(() => compileFormat(format), /cycle detected: node -> node/);
});

test("unknown definition is rejected", () => {
  const format: Format = {
    root: { fields: [{ name: "x", type: "ref", ref: "nope" }] },
  };
  assert.throws(() => compileFormat(format), FormatError);
  assert.throws(() => compileFormat(format), /unknown definition "nope"/);
});

test("forward field reference is rejected", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "data", type: "bytes", length: { ref: "n" } },
        { name: "n", type: "uint8" },
      ],
    },
  };
  assert.throws(() => compileFormat(format), /unknown field reference "n"/);
});

test("reference to a non-integer field is rejected", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "blob", type: "bytes", length: 4 },
        { name: "data", type: "bytes", length: { ref: "blob" } },
      ],
    },
  };
  assert.throws(() => compileFormat(format), /unconditional integer/);
});

test("reference to a conditional integer field is rejected", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "tag", type: "uint8" },
        { name: "n", type: "uint8", when: { ref: "tag", eq: 1 } },
        { name: "data", type: "bytes", length: { ref: "n" } },
      ],
    },
  };
  assert.throws(() => compileFormat(format), /unconditional integer/);
});

test("duplicate field names are rejected", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "x", type: "uint8" },
        { name: "x", type: "uint8" },
      ],
    },
  };
  assert.throws(() => compileFormat(format), /duplicate field name "x"/);
});

test("length multiplication overflow is caught", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "n", type: "uint32le" },
        { name: "data", type: "bytes", length: { ref: "n", scale: 2 ** 32 } },
      ],
    },
  };
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setUint32(0, 0xffffffff, true);
  assert.throws(() => parseBuffer(format, buf), /length overflow/);
});

test("length exceeding the limit is caught", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "n", type: "uint32le" },
        { name: "data", type: "bytes", length: { ref: "n", scale: 3 } },
      ],
    },
  };
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setUint32(0, 0xffffffff, true);
  assert.throws(() => parseBuffer(format, buf), /exceeds limit/);
});

test("array count exceeding the limit is caught", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "count", type: "uint32le" },
        { name: "items", type: "array", count: { ref: "count" }, element: { type: "uint8" } },
      ],
    },
  };
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setUint32(0, 0xffffffff, true);
  assert.throws(() => parseBuffer(format, buf), /count .* exceeds limit/);
});

test("fixed-size array is pre-flighted against remaining input", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "count", type: "uint8" },
        {
          name: "items",
          type: "array",
          count: { ref: "count" },
          element: { type: "uint32le" },
        },
      ],
    },
  };
  assert.throws(() => parseBuffer(format, u8(10, 1, 2, 3)), /exceeds remaining input/);
});

test("truncated input restores the cursor to the structure start", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "a", type: "uint8" },
        { name: "b", type: "uint16le" },
        { name: "c", type: "bytes", length: 4 },
      ],
    },
  };
  const parser = new Parser(u8(1, 2));
  assert.throws(() => parser.run(compileFormat(format)), ParseError);
  assert.equal(parser.offset, 0);
});

test("nested struct failure restores the cursor to the root start", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "pad", type: "uint8" },
        {
          name: "inner",
          type: "struct",
          fields: [
            { name: "x", type: "uint32le" },
            { name: "y", type: "uint32le" },
          ],
        },
      ],
    },
  };
  const parser = new Parser(u8(9, 1, 2));
  assert.throws(() => parser.run(compileFormat(format)), /unexpected end of input/);
  assert.equal(parser.offset, 0);
});

test("cursor restores to the offset where run started", () => {
  const format: Format = {
    root: { fields: [{ name: "x", type: "uint32le" }] },
  };
  const parser = new Parser(u8(0, 0, 0, 1, 2));
  parser.offset = 3; // pretend a header was consumed elsewhere
  assert.throws(() => parser.run(compileFormat(format)), ParseError);
  assert.equal(parser.offset, 3);
});

test("parse error reports the failing offset", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "a", type: "uint8" },
        { name: "b", type: "uint32le" },
      ],
    },
  };
  const parser = new Parser(u8(7, 1));
  try {
    parser.run(compileFormat(format));
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.equal((err as ParseError).offset, 1);
  }
  assert.equal(parser.offset, 0);
});

test("strings decode as utf-8", () => {
  const format: Format = {
    root: {
      fields: [
        { name: "len", type: "uint8" },
        { name: "name", type: "string", length: { ref: "len" } },
      ],
    },
  };
  const { value } = parseBuffer(format, u8(3, 97, 98, 99));
  assert.equal(value.name, "abc");
});
