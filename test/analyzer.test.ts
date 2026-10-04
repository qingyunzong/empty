import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { StreamAnalyzer } from "../src/analyzer";
import { bruteForceBest } from "../src/brute";

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

function analyze(s: string) {
  const a = new StreamAnalyzer();
  a.append(Buffer.from(s, "utf8"));
  return a.best();
}

test("hand-checked basic cases", () => {
  deepEqual(analyze("abcabcbb"), {
    startIndex: 0,
    endIndex: 2,
    startByte: 0,
    endByte: 3,
    length: 3,
  });
  // Empty stream has no fragment.
  equal(analyze(""), null);
  // Single code point.
  deepEqual(analyze("z"), {
    startIndex: 0,
    endIndex: 0,
    startByte: 0,
    endByte: 1,
    length: 1,
  });
});

test("fragment may not cross an unclosed quote", () => {
  // "ab'cd": the quote at index 2 never closes, so no legal boundary exists
  // after index 1; the best fragment is "ab".
  deepEqual(analyze("ab'cd"), {
    startIndex: 0,
    endIndex: 1,
    startByte: 0,
    endByte: 2,
    length: 2,
  });
});

test("fragment boundaries avoid string interiors", () => {
  // "abc'def'gh": the only legal boundaries are around "abc" and "gh".
  deepEqual(analyze("abc'def'gh"), {
    startIndex: 0,
    endIndex: 2,
    startByte: 0,
    endByte: 3,
    length: 3,
  });
});

test("escaped quote does not close the string", () => {
  // a ' \ ' '  -> the \' is an escaped quote; the string only closes at the
  // final quote. Legal boundaries: 0, 1, 5. The all-enclosing candidate
  // contains repeated quotes, so the best fragment is just "a".
  deepEqual(analyze("a'\\''"), {
    startIndex: 0,
    endIndex: 0,
    startByte: 0,
    endByte: 1,
    length: 1,
  });
});

test("combining characters count as code points, not graphemes", () => {
  // "e" + U+0301: two distinct code points, one grapheme.
  const decomposed = analyze("e\u0301");
  equal(decomposed!.length, 2);
  equal(decomposed!.endByte, 3); // 1 + 2 bytes
  // Precomposed "é" is a single code point (2 bytes).
  const precomposed = analyze("é");
  equal(precomposed!.length, 1);
  equal(precomposed!.endByte, 2);
  // Precomposed é vs decomposed e+́ share no code points: all three distinct.
  equal(analyze("é" + "e\u0301")!.length, 3);
  // Two precomposed é repeat the same code point.
  equal(analyze("éé")!.length, 1);
});

test("best fragment reports original byte range", () => {
  const s = "中文字ab中";
  const best = analyze(s)!;
  deepEqual(best, {
    startIndex: 0,
    endIndex: 4,
    startByte: 0,
    endByte: 11, // 3*3 CJK bytes + 2 ASCII bytes
    length: 5,
  });
  const bytes = Buffer.from(s, "utf8");
  equal(bytes.subarray(best.startByte, best.endByte).toString("utf8"), "中文字ab");
});

test("byte chunks may split multi-byte sequences", () => {
  const a = new StreamAnalyzer();
  const bytes = Buffer.from("é中", "utf8"); // 2 + 3 bytes
  for (const b of bytes) {
    a.append(Buffer.from([b]));
  }
  equal(a.codePointCount, 2);
  deepEqual(a.best(), {
    startIndex: 0,
    endIndex: 1,
    startByte: 0,
    endByte: 5,
    length: 2,
  });
});

test("undo restores window, lexer and best candidate", () => {
  const a = new StreamAnalyzer();
  equal(a.undo(), 0); // nothing to undo
  a.append(Buffer.from("ab'cd", "utf8"));
  deepEqual(a.best(), { startIndex: 0, endIndex: 1, startByte: 0, endByte: 2, length: 2 });
  equal(a.undo(3), 3); // remove 'cd and the quote -> stream is "ab"
  deepEqual(a.best(), { startIndex: 0, endIndex: 1, startByte: 0, endByte: 2, length: 2 });
  equal(a.lexDepth, 0);
  a.append(Buffer.from("c'd", "utf8")); // stream: abc'd  (unclosed quote)
  deepEqual(a.best(), { startIndex: 0, endIndex: 2, startByte: 0, endByte: 3, length: 3 });
  equal(a.undo(10), 5); // clamps at stream start
  equal(a.best(), null);
  equal(a.codePointCount, 0);
});

test("save and continue matches uninterrupted analysis", () => {
  const s = "ab'cd\\'ef\"gh\"ijé\u0301中`kl`mn";
  const bytes = Buffer.from(s, "utf8");
  const mid = 7; // splits the escape sequence region
  const a1 = new StreamAnalyzer();
  a1.append(bytes.subarray(0, mid));
  const saved = a1.save();
  const a2 = StreamAnalyzer.load(saved);
  a1.append(bytes.subarray(mid));
  a2.append(bytes.subarray(mid));
  deepEqual(a2.best(), a1.best());
  deepEqual(a2.best(), bruteForceBest(bytes));
  // Undo also works identically after a restore.
  a1.undo(4);
  a2.undo(4);
  deepEqual(a2.best(), a1.best());
  deepEqual(a2.best(), bruteForceBest(bytes.subarray(0, bytes.length - 4)));
});

test("exhaustive short strings match brute force", () => {
  const alphabet = ["a", "b", "'", '"', "\\", "`", "é", "\u0301"];
  const maxLen = 5;
  const current: string[] = [];
  let checked = 0;
  const visit = (s: string) => {
    const bytes = Buffer.from(s, "utf8");
    const a = new StreamAnalyzer();
    a.append(bytes);
    deepEqual(a.best(), bruteForceBest(bytes), `mismatch for ${JSON.stringify(s)}`);
    checked++;
  };
  const walk = (prefix: string, depth: number) => {
    visit(prefix);
    if (depth === 0) {
      return;
    }
    for (const ch of alphabet) {
      walk(prefix + ch, depth - 1);
    }
  };
  walk("", maxLen);
  ok(checked > 30000, `expected broad coverage, checked ${checked}`);
});

test("exhaustive short strings with tail undo match brute force", () => {
  const alphabet = ["a", "'", "\\", "é"];
  const maxLen = 5;
  const walk = (prefix: string, depth: number) => {
    const cps = Array.from(prefix);
    const remove = Math.floor(cps.length / 2);
    const a = new StreamAnalyzer();
    a.append(Buffer.from(prefix, "utf8"));
    a.undo(remove);
    const kept = cps.slice(0, cps.length - remove).join("");
    deepEqual(
      a.best(),
      bruteForceBest(Buffer.from(kept, "utf8")),
      `mismatch for ${JSON.stringify(prefix)} undo ${remove}`,
    );
    if (depth === 0) {
      return;
    }
    for (const ch of alphabet) {
      walk(prefix + ch, depth - 1);
    }
  };
  walk("", maxLen);
});

test("random byte chunks, undos and save/load match full re-lexing", () => {
  const alphabet = [
    "a", "b", "c", "d", "x", "y",
    "'", '"', "`", "\\",
    "é", "\u0301", "中", "🙂",
  ];
  for (let seed = 1; seed <= 5; seed++) {
    const rng = mulberry32(seed);
    const planned: string[] = [];
    for (let i = 0; i < 150; i++) {
      planned.push(alphabet[Math.floor(rng() * alphabet.length)]);
    }
    const fullBytes = Buffer.from(planned.join(""), "utf8");
    let analyzer = new StreamAnalyzer();
    let restores = 0;
    for (let step = 0; step < 500; step++) {
      // The analyzer has consumed exactly byteLength + pendingByteCount
      // bytes of the planned stream; undoing rewinds the feed position.
      const feedPosition = () => analyzer.byteLength + analyzer.pendingByteCount;
      const r = rng();
      if (r < 0.45 && feedPosition() < fullBytes.length) {
        const n = 1 + Math.floor(rng() * 9);
        const start = feedPosition();
        const end = Math.min(fullBytes.length, start + n);
        analyzer.append(fullBytes.subarray(start, end));
      } else if (r < 0.75) {
        analyzer.undo(1 + Math.floor(rng() * 3));
      } else if (r < 0.9) {
        analyzer = StreamAnalyzer.load(analyzer.save());
        restores++;
      } else {
        analyzer.undo(1);
      }
      // Active code points are always a prefix of the planned stream.
      const active = planned.slice(0, analyzer.codePointCount).join("");
      const activeBytes = Buffer.from(active, "utf8");
      equal(analyzer.byteLength, activeBytes.length, `seed ${seed} step ${step}`);
      deepEqual(
        analyzer.best(),
        bruteForceBest(activeBytes),
        `seed ${seed} step ${step}`,
      );
    }
    // Drain any remaining bytes and verify once more.
    analyzer.append(fullBytes.subarray(analyzer.byteLength + analyzer.pendingByteCount));
    deepEqual(analyzer.best(), bruteForceBest(fullBytes), `seed ${seed} final`);
    ok(restores > 0, "expected at least one save/load round trip");
  }
});

test("long stream stays consistent", () => {
  const a = new StreamAnalyzer();
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < 2000; i++) {
    a.append(alphabet);
  }
  const best = a.best()!;
  equal(best.length, 26);
  equal(best.startIndex, 0);
  a.undo(100);
  equal(a.best()!.length, 26);
  equal(a.best()!.startIndex, 0);
});
