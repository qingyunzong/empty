import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChunkScanner,
  findAll,
  maskPreview,
  mergeRanges,
  pattern,
  scan,
  type BytePattern,
  type Range,
  type ScanResult,
} from "../src/scanner.js";

const enc = new TextEncoder();

const PATTERNS: BytePattern[] = [
  pattern("aws-key", "AKIAIOSFODNN7EXAMPLE"),
  pattern("token", "ghp_"),
  pattern("private-key", "-----BEGIN PRIVATE KEY-----"),
  pattern("hex-secret", "deadbeef"),
];

function chunkScan(data: Uint8Array, sizes: number[], whitelist: Range[]): ScanResult {
  const scanner = new ChunkScanner(PATTERNS, { whitelist });
  let off = 0;
  for (const size of sizes) {
    scanner.push(data.subarray(off, off + size));
    off += size;
    assert.ok(off <= data.length, "chunk plan exceeds data length");
  }
  assert.equal(off, data.length, "chunk plan must cover the whole input");
  return scanner.end();
}

function sameResult(a: ScanResult, b: ScanResult): void {
  assert.deepEqual(a.matches, b.matches, "matches differ");
  assert.deepEqual(a.suppressed, b.suppressed, "suppressed differ");
  assert.deepEqual(a.maskedRanges, b.maskedRanges, "maskedRanges differ");
  assert.equal(a.preview, b.preview, "preview differs");
}

/** 可复现的伪随机数（mulberry32）。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("整串扫描报告原始字节偏移", () => {
  const text = "héllo AKIAIOSFODNN7EXAMPLE world ghp_secret";
  const bytes = enc.encode(text);
  const keyAt = text.indexOf("AKIA");
  const tokenAt = text.indexOf("ghp_");
  const r = scan(bytes, PATTERNS);
  assert.equal(r.matches.length, 2);
  // "é" 为 2 字节，偏移必须是字节偏移而非字符偏移
  assert.equal(r.matches[0]!.start, enc.encode(text.slice(0, keyAt)).length);
  assert.equal(r.matches[0]!.end, r.matches[0]!.start + "AKIAIOSFODNN7EXAMPLE".length);
  assert.equal(r.matches[1]!.start, enc.encode(text.slice(0, tokenAt)).length);
  assert.equal(r.matches[1]!.end, r.matches[1]!.start + 4);
});

test("白名单仅遮盖完整包含的命中，部分重叠仍上报", () => {
  const data = "xxAKIAIOSFODNN7EXAMPLEyy ghp_1234 deadbeef";
  const keyStart = data.indexOf("AKIA");
  const keyEnd = keyStart + "AKIAIOSFODNN7EXAMPLE".length;
  const tokenStart = data.indexOf("ghp_");
  const hexStart = data.indexOf("deadbeef");

  // 完整包含 -> 遮盖
  const r1 = scan(data, PATTERNS, { whitelist: [{ start: keyStart - 2, end: keyEnd + 2 }] });
  assert.deepEqual(
    r1.suppressed.map((m) => m.name),
    ["aws-key"],
  );
  assert.equal(r1.matches.length, 2);

  // 区间边界恰好相等也算完整包含
  const r2 = scan(data, PATTERNS, { whitelist: [{ start: keyStart, end: keyEnd }] });
  assert.equal(r2.suppressed.length, 1);

  // 只差一个字节未覆盖 -> 不遮盖
  const r3 = scan(data, PATTERNS, { whitelist: [{ start: keyStart, end: keyEnd - 1 }] });
  assert.equal(r3.suppressed.length, 0);
  assert.equal(r3.matches.length, 3);

  // 部分重叠 token -> 不遮盖；完整包含 hex-secret -> 遮盖
  const r4 = scan(data, PATTERNS, {
    whitelist: [
      { start: tokenStart - 1, end: tokenStart + 2 },
      { start: hexStart, end: hexStart + 8 },
    ],
  });
  assert.deepEqual(
    r4.suppressed.map((m) => m.name),
    ["hex-secret"],
  );
  assert.deepEqual(
    r4.matches.map((m) => m.name),
    ["aws-key", "token"],
  );
});

test("重叠命中归并为连续遮盖区间", () => {
  const pats = [pattern("aa", "aa"), pattern("aaa", "aaa")];
  const r = scan("zaaaaZ", pats);
  // "aa" 命中 3 次（1,2,3），"aaa" 命中 2 次（1,2），全部重叠
  assert.equal(r.matches.length, 5);
  assert.deepEqual(r.maskedRanges, [{ start: 1, end: 5 }]);
  assert.equal(r.preview, "z****Z");

  assert.deepEqual(
    mergeRanges([
      { start: 5, end: 8 },
      { start: 0, end: 3 },
      { start: 3, end: 5 },
      { start: 10, end: 12 },
    ]),
    [
      { start: 0, end: 8 },
      { start: 10, end: 12 },
    ],
  );
});

test("遮盖预览只替换命中区间且保持字节长度", () => {
  const data = "key=AKIAIOSFODNN7EXAMPLE; tok=ghp_xx";
  const r = scan(data, PATTERNS);
  assert.equal(r.preview, "key=********************; tok=****xx");
  assert.equal(enc.encode(r.preview).length, enc.encode(data).length);
  // 自定义遮盖字符
  assert.equal(maskPreview("abcdef", [{ start: 1, end: 4 }], "#"), "a###ef");
});

test("跨块边界的命中不遗漏", () => {
  const data = enc.encode("head AKIAIOSFODNN7EXAMPLE tail");
  const keyStart = data.indexOf(0x41); // 'A' of AKIA
  for (let cut = keyStart - 2; cut <= keyStart + 20; cut++) {
    const r = chunkScan(data, [cut, data.length - cut], []);
    assert.equal(r.matches.length, 1, `cut=${cut}`);
    assert.equal(r.matches[0]!.start, keyStart, `cut=${cut}`);
  }
});

test("任意切块与整串扫描结果一致（随机对照）", () => {
  const rand = rng(20261005);
  const alphabet = "abcXYZ 0123\nAKIAIOSFODNN7EXAMPLE ghp_ deadbeef -----BEGIN PRIVATE KEY-----";
  for (let iter = 0; iter < 300; iter++) {
    const len = 1 + Math.floor(rand() * 400);
    let text = "";
    for (let i = 0; i < len; i++) {
      if (rand() < 0.08) {
        const secret = ["AKIAIOSFODNN7EXAMPLE", "ghp_", "deadbeef", "-----BEGIN PRIVATE KEY-----"];
        text += secret[Math.floor(rand() * secret.length)];
      } else {
        text += alphabet[Math.floor(rand() * alphabet.length)];
      }
    }
    const data = enc.encode(text);

    // 随机白名单：约一半迭代施加随机区间
    const whitelist: Range[] = [];
    if (rand() < 0.5) {
      const n = Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(rand() * (data.length + 1));
        const b = a + Math.floor(rand() * (data.length - a + 1));
        whitelist.push({ start: a, end: b });
      }
    }

    // 随机切块计划：含空块与单字节块
    const sizes: number[] = [];
    let remaining = data.length;
    while (remaining > 0) {
      const size = Math.min(remaining, Math.floor(rand() * (rand() < 0.3 ? 2 : 37)));
      sizes.push(size);
      remaining -= size;
      if (rand() < 0.1) sizes.push(0); // 空块
    }

    const whole = scan(data, PATTERNS, { whitelist });
    const chunked = chunkScan(data, sizes, whitelist);
    sameResult(chunked, whole);
  }
});

test("边界情形：空输入、无模式、单字节块、整块一次推入", () => {
  const empty = scan("", PATTERNS);
  assert.deepEqual(empty.matches, []);
  assert.equal(empty.preview, "");

  const s1 = new ChunkScanner(PATTERNS);
  s1.end();
  assert.deepEqual(s1.end().matches, []);

  const data = enc.encode("xxdeadbeefxx");
  const whole = scan(data, PATTERNS);

  const byByte = new ChunkScanner(PATTERNS);
  for (const b of data) byByte.push(new Uint8Array([b]));
  sameResult(byByte.end(), whole);

  const atOnce = new ChunkScanner(PATTERNS);
  atOnce.push(data);
  sameResult(atOnce.end(), whole);

  const noPatterns = scan(data, []);
  assert.deepEqual(noPatterns.matches, []);
  assert.equal(noPatterns.preview, "xxdeadbeefxx");

  // findAll 对重叠出现逐步滑动
  assert.deepEqual(
    findAll(enc.encode("aaaa"), [pattern("aa", "aa")]).map((m) => [m.start, m.end]),
    [
      [0, 2],
      [1, 3],
      [2, 4],
    ],
  );
});
