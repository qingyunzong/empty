import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { SegmentAnalyzer, type BestSegment } from "../src/analyzer.ts";
import { fullAnalysis } from "../src/brute.ts";
import { encodeUtf8 } from "../src/core.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function analyzeWhole(text: string): BestSegment | null {
  const a = new SegmentAnalyzer();
  a.append(text);
  return a.best();
}

function assertBest(actual: BestSegment | null, expected: BestSegment | null): void {
  deepEqual(actual, expected);
}

// ---------- fixed unit cases ----------

test("ascii: longest distinct run, tie broken by earliest start", () => {
  const best = analyzeWhole("abcabcbb");
  equal(best!.text, "abc");
  equal(best!.length, 3);
  equal(best!.byteStart, 0);
  equal(best!.byteEnd, 3);
});

test("combining marks count as separate code points, not graphemes", () => {
  // "e" + U+0301 is one grapheme but two code points; both are distinct.
  const best = analyzeWhole("éx");
  equal(best!.length, 3);
  equal(best!.byteStart, 0);
  equal(best!.byteEnd, 4); // 1 + 2 + 1 bytes
  // A repeated base letter repeats even with a combining mark on top.
  const dup = analyzeWhole("ée");
  equal(dup!.text, "é");
  equal(dup!.length, 2);
});

test("byte ranges are reported in original bytes for multibyte input", () => {
  const best = analyzeWhole("éé中");
  equal(best!.text, "é中"); // é(2B) é(2B) 中(3B): distinct run starts at index 1
  equal(best!.byteStart, 2);
  equal(best!.byteEnd, 7);
});

test("balanced quotes may be spanned; unclosed quotes may not", () => {
  // A complete string literal always contains two identical quote code
  // points, so it can never be inside a distinct-code-point segment; the
  // best we can do here is the run before the quote (tie with "ef").
  const ok1 = analyzeWhole('ab"cd"ef');
  equal(ok1!.text, "ab");
  const bad = analyzeWhole('ab"cd');
  equal(bad!.text, "ab"); // cannot extend past the unclosed quote
  equal(bad!.byteEnd, 2);
});

test("segment boundary cannot fall inside an escape sequence", () => {
  // a " b \ " c " d e  ->  the \" keeps the string open until the 3rd quote;
  // duplicates of " force the best legal segment to be "de".
  const best = analyzeWhole('a"b\\"c"de');
  equal(best!.text, "de");
  equal(best!.byteStart, 7);
  equal(best!.byteEnd, 9);
});

test("no legal segment when a quote is never closed", () => {
  equal(analyzeWhole('"ab'), null);
  equal(analyzeWhole("'"), null);
});

test("single-quoted and backtick strings with escapes", () => {
  // The escaped quote keeps the string open until the 3rd quote; with three
  // identical quote code points no legal segment spans the literal, and the
  // escape swallows a boundary, leaving the single code point "x" on top.
  const best = analyzeWhole("x'it\\'s'y");
  equal(best!.text, "x");
  const tpl = analyzeWhole("a`b\\`c`d");
  equal(tpl!.text, "a");
});

test("undo restores earlier best candidate", () => {
  const a = new SegmentAnalyzer();
  a.append("abc");
  a.append("abc"); // now best is still "abc"
  equal(a.best()!.text, "abc");
  equal(a.undo(), true);
  equal(a.best()!.text, "abc");
  equal(a.best()!.byteEnd, 3);
  equal(a.undo(), true);
  equal(a.best(), null);
  equal(a.undo(), false);
});

test("multi-byte sequence split across chunks decodes identically", () => {
  const whole = encodeUtf8("中a中");
  const a = new SegmentAnalyzer();
  a.append(whole.subarray(0, 1)); // first byte of 中 only
  equal(a.codePointCount, 0);
  a.append(whole.subarray(1)); // rest
  equal(a.codePointCount, 3);
  const ref = fullAnalysis(whole);
  deepEqual(a.best(), ref);
  equal(a.best()!.text, "中a");
  equal(a.best()!.byteEnd, 4);
});

// ---------- exhaustive short strings ----------

test("exhaustive: all strings up to length 6 over a tricky alphabet", () => {
  const alphabet = ["a", "b", "'", '"', "\\", "é", "́"];
  const maxLen = 6;
  let checked = 0;
  const recurse = (s: string): void => {
    const data = encodeUtf8(s);
    const expected = fullAnalysis(data);
    // Whole-buffer append.
    const a = new SegmentAnalyzer();
    a.append(data);
    deepEqual(a.best(), expected, `whole: ${JSON.stringify(s)}`);
    // Two-chunk split at a random-ish byte boundary (may split a code point).
    if (data.length > 1) {
      const cut = 1 + ((s.length * 7 + 3) % (data.length - 1));
      const b = new SegmentAnalyzer();
      b.append(data.subarray(0, cut));
      b.append(data.subarray(cut));
      deepEqual(b.best(), expected, `split: ${JSON.stringify(s)}`);
    }
    checked++;
    if (s.length < maxLen) {
      for (const ch of alphabet) recurse(s + ch);
    }
  };
  recurse("");
  ok(checked > 19000, `expected many cases, got ${checked}`);
});

// ---------- randomized cross-checks ----------

const POOL = ["a", "b", "c", "d", "é", "中", "💪", "́", "'", '"', "`", "\\", "x", "yz"];

function randomText(rand: () => number, maxLen: number): string {
  const n = Math.floor(rand() * maxLen);
  let s = "";
  for (let i = 0; i < n; i++) s += POOL[Math.floor(rand() * POOL.length)];
  return s;
}

function randomChunks(rand: () => number, data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  while (pos < data.length) {
    const step = 1 + Math.floor(rand() * Math.max(1, Math.min(9, data.length - pos)));
    chunks.push(data.subarray(pos, Math.min(data.length, pos + step)));
    pos += step;
  }
  return chunks;
}

test("random byte chunking matches full lex + substring enumeration", () => {
  const rand = mulberry32(20261005);
  for (let trial = 0; trial < 400; trial++) {
    const data = encodeUtf8(randomText(rand, 40));
    const a = new SegmentAnalyzer();
    for (const chunk of randomChunks(rand, data)) a.append(chunk);
    deepEqual(a.best(), fullAnalysis(data), `trial ${trial}`);
  }
});

test("random interleaved append/undo matches oracle after every step", () => {
  const rand = mulberry32(987654321);
  for (let trial = 0; trial < 150; trial++) {
    const a = new SegmentAnalyzer();
    const live: Uint8Array[] = []; // chunks currently in effect
    const remaining = randomChunks(rand, encodeUtf8(randomText(rand, 30)));
    const concat = (): Uint8Array => {
      const total = live.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of live) { out.set(c, off); off += c.length; }
      return out;
    };
    let step = 0;
    while (remaining.length > 0 || (live.length > 0 && rand() < 0.5)) {
      if (remaining.length > 0 && (live.length === 0 || rand() < 0.65)) {
        const chunk = remaining.shift()!;
        a.append(chunk);
        live.push(chunk);
      } else {
        ok(a.undo());
        live.pop();
      }
      deepEqual(a.best(), fullAnalysis(concat()), `trial ${trial} step ${step}`);
      step++;
    }
  }
});

test("save/restore (incl. JSON round-trip) continues identically", () => {
  const rand = mulberry32(1122334455);
  for (let trial = 0; trial < 120; trial++) {
    const chunks = randomChunks(rand, encodeUtf8(randomText(rand, 30)));
    const splitAt = Math.floor(rand() * (chunks.length + 1));

    const original = new SegmentAnalyzer();
    for (const c of chunks.slice(0, splitAt)) original.append(c);
    const snap = original.save();

    // Continue the original with appends and undos.
    const ops: ("append" | "undo")[] = [];
    const tail = chunks.slice(splitAt);
    let appended = 0;
    for (const c of tail) {
      ops.push("append");
      original.append(c);
      appended++;
      if (rand() < 0.35) {
        ops.push("undo");
        original.undo();
        appended--;
      }
    }
    void appended;

    // Replay from a JSON round-tripped snapshot.
    const revived = SegmentAnalyzer.restore(JSON.parse(JSON.stringify(snap)));
    let ti = 0;
    for (const op of ops) {
      if (op === "append") revived.append(tail[ti++]);
      else revived.undo();
    }
    deepEqual(revived.best(), original.best(), `trial ${trial}: restored vs original`);

    // And both must agree with the brute-force oracle on the live bytes.
    const liveChunks = chunks.slice(0, splitAt);
    let ai = 0;
    for (const op of ops) {
      if (op === "append") liveChunks.push(tail[ai++]);
      else liveChunks.pop();
    }
    const total = liveChunks.reduce((n, c) => n + c.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of liveChunks) { buf.set(c, off); off += c.length; }
    deepEqual(original.best(), fullAnalysis(buf), `trial ${trial}: original vs oracle`);
  }
});

test("snapshot undo reaches back across the save point", () => {
  const a = new SegmentAnalyzer();
  a.append("ab");
  const snap = a.save();
  a.append("cd");
  const b = SegmentAnalyzer.restore(snap);
  equal(b.best()!.text, "ab");
  equal(b.undo(), true); // undoes "ab", appended before save()
  equal(b.best(), null);
  equal(a.best()!.text, "abcd");
});
