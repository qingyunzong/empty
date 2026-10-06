import test from "node:test";
import assert from "node:assert/strict";
import {
  SHY,
  NBSP,
  layoutText,
  parseText,
  solveBruteForce,
  solveLayout,
  uniformWidths,
  verifyCertificate,
  type LayoutInput,
  type LayoutResult,
} from "../src/index.js";

const w1 = (extra: string = "") => uniformWidths("abcdefghijklmnopqrstuvwxyz" + extra, 1);

function ok(result: LayoutResult) {
  assert.equal(result.ok, true, result.ok ? "" : `unexpected failure: ${result.reason}`);
  return result as Extract<LayoutResult, { ok: true }>;
}

test("basic layout: squared slack objective, last line free, spans reported", () => {
  const res = ok(solveLayout({ words: parseText("aa bb cc"), widths: w1(), lineWidth: 5 }));
  assert.equal(res.bound, 0);
  assert.deepEqual(res.certificate.breakpoints, [2]);
  const [l0, l1] = res.certificate.lines;
  assert.equal(l0.text, "aa bb");
  assert.equal(l0.width, 5);
  assert.equal(l0.slack, 0);
  assert.equal(l0.cost, 0);
  assert.equal(l0.charStart, 0);
  assert.equal(l0.charEnd, 5);
  assert.deepEqual([l0.startWord, l0.endWord], [0, 2]);
  assert.equal(l1.text, "cc");
  assert.equal(l1.cost, 0, "last line is not penalized");
  assert.equal(l1.slack, 3);
  assert.equal(l1.charStart, 6);
  assert.equal(l1.charEnd, 8);
});

test("single short word: one free last line, zero cost", () => {
  const res = ok(solveLayout({ words: parseText("aaaa"), widths: w1(), lineWidth: 10 }));
  assert.equal(res.bound, 0);
  assert.equal(res.certificate.lines.length, 1);
});

test("objective prefers balanced slack over greedy fill", () => {
  // "aaa bbb cc" width 8,8,5 with spaces: greedy [aaa bbb][cc] costs 0+...
  const res = ok(
    solveLayout({ words: parseText("aa bb cc dd"), widths: w1(), lineWidth: 5 }),
  );
  // [aa bb][cc dd]: slack 0 + last free = 0 beats [aa bb][cc][dd] = 0+9+0.
  assert.equal(res.bound, 0);
  assert.deepEqual(res.certificate.breakpoints, [2]);
});

test("tie-break: lexicographically smallest breakpoint sequence wins", () => {
  // Two optimal layouts with cost 11: [1,3,4] and [2,3,4].
  const res = ok(
    solveLayout({ words: parseText("a a a aaa a"), widths: w1(), lineWidth: 4 }),
  );
  assert.equal(res.bound, 11);
  assert.deepEqual(res.certificate.breakpoints, [1, 3, 4]);
});

test("missing character width is an explicit failure", () => {
  const res = solveLayout({ words: parseText("aa bb"), widths: { a: 1, " ": 1, "-": 1 }, lineWidth: 5 });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "missing-char-width");
    assert.equal(res.char, "b");
  }
});

test("overlong unbreakable word fails explicitly and names the word", () => {
  const res = solveLayout({
    words: parseText("ok aaaaaaaaaa ok"),
    widths: w1(),
    lineWidth: 5,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "unbreakable-word-too-wide");
    assert.equal(res.word, "aaaaaaaaaa");
    assert.equal(res.width, 10);
    assert.equal(res.limit, 5);
  }
});

test("overlong fragment (soft breaks cannot save it) fails explicitly", () => {
  const res = solveLayout({
    words: [{ text: `aaaaaa${SHY}b` }],
    widths: w1(),
    lineWidth: 5,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "unbreakable-fragment-too-wide");
});

test("unbreakable region (NBSP glue) keeps words on one line", () => {
  const glued = ok(
    solveLayout({
      words: [{ text: "a", glueAfter: true }, { text: "b" }, { text: "c" }],
      widths: w1(),
      lineWidth: 3,
    }),
  );
  assert.equal(glued.bound, 0);
  assert.deepEqual(glued.certificate.breakpoints, [2]);
  assert.equal(glued.certificate.lines[0].text, "a b");

  // The glued unit "a b" (width 3) cannot fit width 2: infeasible.
  const tight = solveLayout({
    words: [{ text: "a", glueAfter: true }, { text: "b" }],
    widths: w1(),
    lineWidth: 2,
  });
  assert.equal(tight.ok, false);
  if (!tight.ok) assert.equal(tight.reason, "no-feasible-layout");
});

test("soft hyphens: hyphen width counted, break sequence reported", () => {
  const res = ok(
    solveLayout({ words: [{ text: `ab${SHY}cd${SHY}ef` }], widths: w1(), lineWidth: 3 }),
  );
  assert.equal(res.bound, 0);
  assert.deepEqual(res.certificate.breakpoints, [1, 2]);
  assert.equal(res.certificate.hyphenations, 2);
  const [l0, l1, l2] = res.certificate.lines;
  assert.equal(l0.text, "ab-");
  assert.equal(l0.width, 3, "hyphen width included");
  assert.equal(l0.endsWithHyphen, true);
  assert.equal(l1.text, "cd-");
  assert.equal(l2.text, "ef");
  assert.equal(l2.endsWithHyphen, false);
});

test("maxHyphenations=K bounds in-word breaks", () => {
  const words = [{ text: `ab${SHY}cd${SHY}ef` }];
  const widths = w1();
  const k1 = solveLayout({ words, widths, lineWidth: 3, maxHyphenations: 1 });
  assert.equal(k1.ok, false, "needs 2 hyphenations, K=1 infeasible");
  const k0 = solveLayout({ words, widths, lineWidth: 3, maxHyphenations: 0 });
  assert.equal(k0.ok, false);
  const k2 = ok(solveLayout({ words, widths, lineWidth: 3, maxHyphenations: 2 }));
  assert.equal(k2.certificate.hyphenations, 2);
});

test("floating image steals width on specified lines", () => {
  const words = parseText("aa bb cc dd");
  const widths = w1();
  const plain = ok(solveLayout({ words, widths, lineWidth: 5 }));
  assert.equal(plain.bound, 0);

  const floated = ok(
    solveLayout({
      words,
      widths,
      lineWidth: 5,
      floats: [{ startLine: 0, lineCount: 1, width: 2 }],
    }),
  );
  assert.equal(floated.certificate.lines[0].available, 3);
  assert.deepEqual(floated.certificate.breakpoints, [1, 3]);
  assert.equal(floated.bound, 1);
});

test("floating image with variable per-line width", () => {
  const res = ok(
    solveLayout({
      words: parseText("aa bb cc dd"),
      widths: w1(),
      lineWidth: 5,
      floats: [{ startLine: 0, lineCount: 2, width: [0, 2] }],
    }),
  );
  assert.equal(res.certificate.lines[0].available, 5);
  assert.equal(res.certificate.lines[1].available, 3);
  assert.equal(res.bound, 1);
});

test("line width depends on previous breakpoint state (hyphen carry)", () => {
  const words = [{ text: `ab${SHY}cd` }, { text: "e" }];
  const widths = w1();
  const plain = ok(solveLayout({ words, widths, lineWidth: 3 }));
  assert.equal(plain.bound, 1);
  assert.equal(plain.certificate.lines[1].available, 3);

  const carried = ok(solveLayout({ words, widths, lineWidth: 3, hyphenCarryWidth: 1 }));
  assert.equal(carried.certificate.lines[0].endsWithHyphen, true);
  assert.equal(carried.certificate.lines[1].available, 2, "carry shrinks next line");
  assert.equal(carried.bound, 0);
});

test("widow/orphan control forbids a lone line at a page edge", () => {
  const words = parseText("a b c d");
  const widths = w1();
  const plain = ok(solveLayout({ words, widths, lineWidth: 1 }));
  assert.equal(plain.certificate.lines.length, 4);

  // 4 lines with pageHeight 3 -> last page would hold a single line.
  const paged = solveLayout({ words, widths, lineWidth: 1, pageHeight: 3 });
  assert.equal(paged.ok, false);
  if (!paged.ok) assert.equal(paged.reason, "no-feasible-layout");

  // 5 lines -> pages of 3 and 2 lines: allowed.
  const five = ok(
    solveLayout({ words: parseText("a b c d e"), widths, lineWidth: 1, pageHeight: 3 }),
  );
  assert.equal(five.certificate.lines.length, 5);
});

test("orphan control respects the paragraph start offset", () => {
  const words = parseText("a b c d e");
  const widths = w1();
  // Paragraph starts at absolute line 2: first page would hold 1 line.
  const orphan = solveLayout({
    words, widths, lineWidth: 1, pageHeight: 3, startLineOffset: 2,
  });
  assert.equal(orphan.ok, false);
  // Starting at line 1: pages hold 2 and 3 lines.
  const fine = ok(
    solveLayout({ words, widths, lineWidth: 1, pageHeight: 3, startLineOffset: 1 }),
  );
  assert.equal(fine.certificate.lines.length, 5);
});

test("minLastLineWords forbids a one-word last line", () => {
  const words = parseText("aa bb c");
  const widths = w1();
  const plain = ok(solveLayout({ words, widths, lineWidth: 5 }));
  assert.equal(plain.bound, 0);
  assert.equal(plain.certificate.lines[1].text, "c");

  const guarded = ok(solveLayout({ words, widths, lineWidth: 5, minLastLineWords: 2 }));
  assert.equal(guarded.bound, 9);
  assert.equal(guarded.certificate.lines[1].text, "bb c");
});

test("certificate verifies; tampering is detected", () => {
  const input: LayoutInput = {
    words: parseText(`aa bb ab${SHY}cd ef g`),
    widths: w1(),
    lineWidth: 6,
    maxHyphenations: 1,
    floats: [{ startLine: 1, lineCount: 1, width: 2 }],
  };
  const res = ok(solveLayout(input));
  const check = verifyCertificate(input, res.certificate);
  assert.equal(check.valid, true, check.errors.join("; "));
  assert.equal(check.cost, res.bound);

  const badCost = verifyCertificate(input, {
    ...res.certificate,
    totalCost: res.certificate.totalCost + 1,
  });
  assert.equal(badCost.valid, false);

  const badBreak = verifyCertificate(input, {
    ...res.certificate,
    breakpoints: [...res.certificate.breakpoints, 1].sort((a, b) => a - b),
  });
  assert.equal(badBreak.valid, false);
});

test("layoutText + parseText handle NBSP and soft hyphens", () => {
  const res = ok(
    layoutText({
      text: `aa${NBSP}bb cc d${SHY}d`,
      widths: w1(),
      lineWidth: 5,
    }),
  );
  const check = verifyCertificate(
    { words: parseText(`aa${NBSP}bb cc d${SHY}d`), widths: w1(), lineWidth: 5 },
    res.certificate,
  );
  assert.equal(check.valid, true, check.errors.join("; "));
});

test("non-integer line width rejected", () => {
  assert.throws(() =>
    solveLayout({ words: parseText("a b"), widths: w1(), lineWidth: 2.5 }),
  );
});

// --- Full-enumeration cross-check on short texts -----------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInput(rnd: () => number): LayoutInput {
  const alphabet = "abc";
  const widths: Record<string, number> = { " ": 1, "-": 1 };
  for (const ch of alphabet) widths[ch] = 1 + Math.floor(rnd() * 3);
  const nWords = 1 + Math.floor(rnd() * 5);
  const words = [];
  for (let i = 0; i < nWords; i++) {
    const len = 1 + Math.floor(rnd() * 5);
    let text = "";
    for (let j = 0; j < len; j++) {
      text += alphabet[Math.floor(rnd() * alphabet.length)];
      if (j < len - 1 && rnd() < 0.3) text += SHY;
    }
    words.push({ text, glueAfter: rnd() < 0.1 });
  }
  const input: LayoutInput = {
    words,
    widths,
    lineWidth: 4 + Math.floor(rnd() * 7),
  };
  if (rnd() < 0.5) input.maxHyphenations = Math.floor(rnd() * 3);
  if (rnd() < 0.4) {
    const lineCount = 1 + Math.floor(rnd() * 2);
    input.floats = [{
      startLine: Math.floor(rnd() * 2),
      lineCount,
      width: rnd() < 0.5
        ? Math.floor(rnd() * 3)
        : Array.from({ length: lineCount }, () => Math.floor(rnd() * 3)),
    }];
  }
  if (rnd() < 0.3) input.startLineOffset = Math.floor(rnd() * 3);
  if (rnd() < 0.3) input.hyphenCarryWidth = Math.floor(rnd() * 2);
  if (rnd() < 0.3) input.hyphenCarryWidth = Math.floor(rnd() * 2);
  if (rnd() < 0.3) input.pageHeight = 3 + Math.floor(rnd() * 3);
  if (rnd() < 0.2) input.minLastLineWords = 2;
  return input;
}

test("DP solver matches full-enumeration reference on random short texts", () => {
  const rnd = mulberry32(20261006);
  let feasible = 0;
  let failed = 0;
  for (let i = 0; i < 400; i++) {
    const input = randomInput(rnd);
    const fast = solveLayout(input);
    const slow = solveBruteForce(input);
    assert.equal(fast.ok, slow.ok, `case ${i}: ${JSON.stringify(input.words)}`);
    if (!fast.ok || !slow.ok) {
      assert.equal(fast.ok ? "" : fast.reason, slow.ok ? "" : slow.reason, `case ${i} reason`);
      failed++;
      continue;
    }
    feasible++;
    assert.equal(fast.bound, slow.bound, `case ${i} bound`);
    assert.deepEqual(
      fast.certificate.breakpoints,
      slow.certificate.breakpoints,
      `case ${i} breakpoints`,
    );
    const check = verifyCertificate(input, fast.certificate);
    assert.equal(check.valid, true, `case ${i} cert: ${check.errors.join("; ")}`);
    assert.equal(check.cost, fast.bound, `case ${i} cert cost equals bound`);
  }
  assert.ok(feasible > 100, `expected many feasible cases, got ${feasible}`);
  assert.ok(failed > 10, `expected some infeasible cases, got ${failed}`);
});

test("handles a 40-word paragraph quickly and certifies it", () => {
  const rnd = mulberry32(40);
  const words = [];
  for (let i = 0; i < 40; i++) {
    const len = 2 + Math.floor(rnd() * 6);
    let text = "";
    for (let j = 0; j < len; j++) {
      text += "abcdef"[Math.floor(rnd() * 6)];
      if (j < len - 1 && rnd() < 0.25) text += SHY;
    }
    words.push({ text });
  }
  const input: LayoutInput = {
    words,
    widths: w1(),
    lineWidth: 24,
    maxHyphenations: 4,
    floats: [{ startLine: 1, lineCount: 2, width: [6, 3] }],
    hyphenCarryWidth: 1,
    pageHeight: 4,
    minLastLineWords: 2,
  };
  const start = Date.now();
  const res = ok(solveLayout(input));
  assert.ok(Date.now() - start < 2000, "solver should be fast for 40 words");
  const check = verifyCertificate(input, res.certificate);
  assert.equal(check.valid, true, check.errors.join("; "));
  assert.ok(res.certificate.hyphenations <= 4);
});
