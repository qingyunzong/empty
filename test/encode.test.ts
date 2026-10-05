import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, encodePairs, digestHex, EncodeError } from "../src/index.js";

function hex(value: Parameters<typeof encode>[0]): string {
  return encode(value).toString("hex");
}

test("integer encodings are minimal and big-endian", () => {
  assert.equal(hex(0), "010100");
  assert.equal(hex(1), "010101");
  assert.equal(hex(255), "0101ff");
  assert.equal(hex(256), "01020100");
  assert.equal(hex(9007199254740991), "01071fffffffffffff");
  assert.equal(hex(-1), "020100");
  assert.equal(hex(-256), "0201ff");
  assert.equal(hex(-257), "02020100");
  assert.equal(hex(2n ** 200n), "011a0100000000000000000000000000000000000000000000000000");
  assert.equal(hex(-(2n ** 200n) - 1n), "021a0100000000000000000000000000000000000000000000000000");
});

test("byte strings carry a 4-byte length", () => {
  assert.equal(hex(new Uint8Array([])), "0300000000");
  assert.equal(hex(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), "0300000004deadbeef");
});

test("arrays nest", () => {
  assert.equal(hex([]), "0400000000");
  assert.equal(hex([1, [2, 3]]), "0400000002" + "010101" + "0400000002" + "010102" + "010103");
});

test("object keys are sorted by UTF-8 byte order", () => {
  assert.equal(hex({ b: 1, a: 2 }), "0500000002" + "060000000161" + "010102" + "060000000162" + "010101");
  // 'z' (0x7a) sorts before 'é' (0xc3 0xa9); 'a' before 'aa'; '🙂' is 4 bytes.
  const out = hex({ "🙂": 1, é: 2, z: 3, aa: 4, a: 5 });
  const order = ["a", "aa", "z", "é", "🙂"].map((k) => Buffer.from(k, "utf8").toString("hex"));
  let at = -1;
  for (const k of order) {
    const next = out.indexOf(k, at + 1);
    assert.ok(next > at, `key ${k} out of order in ${out}`);
    at = next;
  }
});

test("digest is independent of object insertion order", () => {
  const a = digestHex({ x: 1, y: [2, 3], z: { p: 0, q: new Uint8Array([9]) } });
  const b = digestHex({ z: { q: new Uint8Array([9]), p: 0 }, y: [2, 3], x: 1 });
  assert.equal(a, b);
});

test("lone surrogates in keys are rejected", () => {
  for (const key of ["\uD800", "\uDC00", "a\uD800", "\uD800x", "\uDC00\uD800"]) {
    assert.throws(() => encode({ [key]: 1 }), EncodeError, key);
  }
  // Valid astral characters (proper surrogate pairs) are accepted.
  assert.equal(hex({ "🙂": 1 }), "0500000001" + "0600000004f09f9982" + "010101");
});

test("duplicate keys from explicit pairs are rejected", () => {
  assert.throws(() => encodePairs([["a", 1], ["a", 2]]), /duplicate object key/);
  assert.equal(encodePairs([["b", 1], ["a", 2]]).toString("hex"), hex({ a: 2, b: 1 }));
});

test("non-integer and unsafe numbers are rejected", () => {
  assert.throws(() => encode(1.5), EncodeError);
  assert.throws(() => encode(NaN), EncodeError);
  assert.throws(() => encode(2 ** 53), EncodeError);
  assert.throws(() => encode(-(2 ** 53)), EncodeError);
});

test("unsupported value types are rejected", () => {
  assert.throws(() => encode(null as never), EncodeError);
  assert.throws(() => encode(undefined as never), EncodeError);
  assert.throws(() => encode("str" as never), EncodeError);
  assert.throws(() => encode(true as never), EncodeError);
});
