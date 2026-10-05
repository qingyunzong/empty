import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encode, digestHex, StreamParser, type CanonicalValue } from "../src/index.js";

/**
 * Independent recursive encoder, written separately from src/encode.ts:
 * builds plain number arrays, derives key order with TextEncoder, and
 * computes integer magnitudes by repeated shifting. The library under test
 * must produce byte-identical output.
 */
function refEncode(value: CanonicalValue): number[] {
  if (typeof value === "number" || typeof value === "bigint") {
    let n = BigInt(value);
    let tag = 0x01;
    if (n < 0n) {
      tag = 0x02;
      n = -1n - n;
    }
    const mag: number[] = [];
    do {
      mag.unshift(Number(n & 0xffn));
      n >>= 8n;
    } while (n > 0n);
    return [tag, mag.length, ...mag];
  }
  if (value instanceof Uint8Array) {
    return [0x03, ...u32(value.length), ...value];
  }
  if (Array.isArray(value)) {
    const out = [0x04, ...u32(value.length)];
    for (const item of value) out.push(...refEncode(item));
    return out;
  }
  const entries: [string, CanonicalValue][] =
    value instanceof Map ? [...value.entries()] : Object.entries(value);
  const encoder = new TextEncoder();
  const keyed = entries.map(([k, v]) => ({ bytes: encoder.encode(k), value: v }));
  keyed.sort((a, b) => {
    const n = Math.min(a.bytes.length, b.bytes.length);
    for (let i = 0; i < n; i++) if (a.bytes[i] !== b.bytes[i]) return a.bytes[i] - b.bytes[i];
    return a.bytes.length - b.bytes.length;
  });
  const out = [0x05, ...u32(keyed.length)];
  for (const { bytes, value: v } of keyed) {
    out.push(0x06, ...u32(bytes.length), ...bytes, ...refEncode(v));
  }
  return out;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function show(value: CanonicalValue): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? [...v] : v);
}

const KEY_POOL = ["a", "b", "z", "A", "aa", "ab", "é", "中", "🙂", "key", "x1", "ÿ"];

function randomValue(rnd: () => number, depth: number): CanonicalValue {
  const r = rnd();
  if (depth <= 0 || r < 0.3) {
    const kind = rnd();
    if (kind < 0.4) return Math.floor(rnd() * 2000) - 1000;
    if (kind < 0.7) return -Math.floor(rnd() * 256) - 1;
    const bits = 64n + BigInt(Math.floor(rnd() * 140));
    return (1n << bits) + BigInt(Math.floor(rnd() * 1e9));
  }
  if (r < 0.45) {
    const len = Math.floor(rnd() * 24);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(rnd() * 256);
    return bytes;
  }
  if (r < 0.7) {
    const len = Math.floor(rnd() * 5);
    return Array.from({ length: len }, () => randomValue(rnd, depth - 1));
  }
  const count = Math.floor(rnd() * 5);
  const obj: Record<string, CanonicalValue> = {};
  while (Object.keys(obj).length < count) {
    const parts = Math.floor(rnd() * 2) + 1;
    let key = "";
    for (let i = 0; i < parts; i++) key += KEY_POOL[Math.floor(rnd() * KEY_POOL.length)];
    obj[key] = randomValue(rnd, depth - 1);
  }
  return obj;
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("library encoder matches the independent recursive encoder", () => {
  const rnd = mulberry32(0xc0ffee);
  for (let i = 0; i < 300; i++) {
    const value = randomValue(rnd, 4);
    assert.deepEqual(
      [...encode(value)],
      refEncode(value),
      `mismatch on case ${i}: ${show(value)}`,
    );
  }
});

test("digest is independent of object insertion order", () => {
  const rnd = mulberry32(0xdecaf);
  for (let i = 0; i < 100; i++) {
    const value = randomValue(rnd, 4);
    const reference = digestHex(value);
    // Rebuild every object with shuffled key insertion order, as a Map.
    const shuffled = reshuffle(value, rnd);
    assert.equal(digestHex(shuffled), reference, `digest changed on case ${i}`);
  }
});

function reshuffle(value: CanonicalValue, rnd: () => number): CanonicalValue {
  if (Array.isArray(value) && !(value instanceof Uint8Array)) {
    return value.map((item) => reshuffle(item, rnd));
  }
  if (value instanceof Uint8Array) return value;
  if (typeof value === "object" && value !== null) {
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
    return new Map(shuffle(entries, rnd).map(([k, v]) => [k, reshuffle(v, rnd)]));
  }
  return value;
}

test("digest equals sha256 of the independent encoder's bytes", () => {
  const rnd = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const value = randomValue(rnd, 4);
    const expected = createHash("sha256").update(Buffer.from(refEncode(value))).digest("hex");
    assert.equal(digestHex(value), expected, `digest mismatch on case ${i}`);
  }
});

test("known-answer: canonical bytes and sha256 digest of a fixed value", () => {
  const value = {
    name: new Uint8Array([115, 105, 103]),
    tags: [1, 2],
    n: -42,
    blob: new Uint8Array([0xde, 0xad]),
  };
  assert.equal(
    encode(value).toString("hex"),
    "0500000004" +
      "0600000004626c6f62" + "0300000002dead" +
      "06000000016e" + "020129" +
      "06000000046e616d65" + "0300000003736967" +
      "060000000474616773" + "0400000002" + "010101" + "010102",
  );
  assert.equal(digestHex(value), "29ec88d3eeb6d3bafac137b837ef6499df77fb72283d4dd5e6faea56adf39333");
});

test("streaming parser decodes exactly what the independent encoder wrote", () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 50; i++) {
    const value = randomValue(rnd, 4);
    const bytes = Buffer.from(refEncode(value));
    const parsed: unknown[] = [];
    const parser = new StreamParser((v) => parsed.push(v));
    // Feed in odd-sized chunks to stress reassembly.
    let at = 0;
    while (at < bytes.length) {
      const step = 1 + Math.floor(rnd() * 17);
      parser.push(bytes.subarray(at, at + step));
      at += step;
    }
    parser.end();
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], toParsedForm(value), `parse mismatch on case ${i}`);
  }
});

function toParsedForm(value: CanonicalValue): unknown {
  if (typeof value === "bigint") {
    return value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value;
  }
  if (typeof value === "number") return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(toParsedForm);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return new Map(entries.map(([k, v]) => [k, toParsedForm(v)]));
}
