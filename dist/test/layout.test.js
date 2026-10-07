"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const index_1 = require("../src/index");
const W = (text, softBreaks, keepWithNext) => ({
    text,
    ...(softBreaks ? { softBreaks } : {}),
    ...(keepWithNext ? { keepWithNext } : {}),
});
// Width table: every letter is 1 unit wide, so a word's width is its length.
const UNIT = {};
for (const ch of 'abcdefghijklmnopqrstuvwxyz')
    UNIT[ch] = 1;
function base(words, maxWidth, extra = {}) {
    return { words, widths: UNIT, spaceWidth: 1, maxWidth, ...extra };
}
(0, node_test_1.default)('basic: minimizes sum of squared slack, last line free', () => {
    const r = (0, index_1.layout)(base([W('aaa'), W('bbb'), W('ccc'), W('ddd')], 7));
    strict_1.default.equal(r.ok, true);
    // "aaa bbb" (7, slack 0) + "ccc ddd" (last, free)
    strict_1.default.equal(r.cost, 0);
    strict_1.default.equal(r.lines.length, 2);
    strict_1.default.deepEqual(r.lines.map((l) => l.text), ['aaa bbb', 'ccc ddd']);
    strict_1.default.deepEqual(r.lines.map((l) => [l.startWord, l.endWord]), [[0, 1], [2, 3]]);
});
(0, node_test_1.default)('last line slack is not penalized', () => {
    const r = (0, index_1.layout)(base([W('aaaaa'), W('b'), W('c')], 5));
    strict_1.default.equal(r.ok, true);
    strict_1.default.equal(r.cost, 0); // first line exactly 5, rest rides free on line 2
    strict_1.default.deepEqual(r.lines.map((l) => l.text), ['aaaaa', 'b c']);
    strict_1.default.equal(r.lines[1].slack, 2); // reported but not charged
});
(0, node_test_1.default)('tie-break: lexicographically smallest breakpoint sequence wins', () => {
    // widths [3,2,2,6,5], space 1, maxWidth 10.
    // Two optima with cost 17 = 4^2+1^2 = 1^2+4^2:
    //   breaks after words {1,3}: lines 6 / 9 / 5
    //   breaks after words {2,3}: lines 9 / 6 / 5  -> lexicographically larger
    const words = [W('ccc'), W('bb'), W('aa'), W('ffffff'), W('eeeee')];
    const r = (0, index_1.layout)(base(words, 10));
    strict_1.default.equal(r.ok, true);
    strict_1.default.equal(r.cost, 17);
    strict_1.default.deepEqual(r.breaks.map((b) => b.afterWord), [1, 3]);
    strict_1.default.deepEqual(r.lines.map((l) => l.text), ['ccc bb', 'aa ffffff', 'eeeee']);
    // certificate consistency: recomputed cost matches the reported bound
    const recomputed = r.lines.slice(0, -1).reduce((s, l) => s + l.slack * l.slack, 0);
    strict_1.default.equal(recomputed, r.cost);
});
(0, node_test_1.default)('overwide unbreakable word fails explicitly', () => {
    const r = (0, index_1.layout)(base([W('ok'), W('thiswordiswaytoolong'), W('ok')], 8));
    strict_1.default.equal(r.ok, false);
    if (!r.ok) {
        strict_1.default.equal(r.kind, 'unbreakable-overflow');
        if (r.kind === 'unbreakable-overflow') {
            strict_1.default.equal(r.wordIndex, 1);
            strict_1.default.equal(r.text, 'thiswordiswaytoolong');
            strict_1.default.equal(r.width, 20);
            strict_1.default.equal(r.limit, 8);
        }
    }
});
(0, node_test_1.default)('soft breaks: hyphenation, hyphen width, and K limit', () => {
    const words = [W('abcdef', [3])];
    const r = (0, index_1.layout)(base(words, 4, { hyphenWidth: 1 }));
    strict_1.default.equal(r.ok, true);
    strict_1.default.equal(r.cost, 0); // "abc-" is exactly 4
    strict_1.default.equal(r.hyphenations, 1);
    strict_1.default.deepEqual(r.lines.map((l) => l.text), ['abc-', 'def']);
    strict_1.default.deepEqual(r.lines.map((l) => [l.startOffset, l.endOffset]), [[0, 3], [3, 6]]);
    strict_1.default.deepEqual(r.breaks.map((b) => b.kind), ['hyphen']);
    // Forbidding hyphenation makes the paragraph infeasible (word too wide
    // for the measure but fragments fit only via the soft break).
    const r0 = (0, index_1.layout)(base(words, 4, { hyphenWidth: 1, maxHyphenations: 0 }));
    strict_1.default.equal(r0.ok, false);
    if (!r0.ok)
        strict_1.default.equal(r0.kind, 'infeasible');
});
(0, node_test_1.default)('at most K hyphenations across the paragraph', () => {
    const words = [W('abcd', [2]), W('efgh', [2])];
    // maxWidth 2 forces every fragment onto its own line: 2 hyphenations needed.
    const denied = (0, index_1.layout)(base(words, 2, { hyphenWidth: 0, maxHyphenations: 1 }));
    strict_1.default.equal(denied.ok, false);
    const r = (0, index_1.layout)(base(words, 2, { hyphenWidth: 0, maxHyphenations: 2 }));
    strict_1.default.equal(r.ok, true);
    strict_1.default.equal(r.hyphenations, 2);
    strict_1.default.equal(r.lines.length, 4);
    strict_1.default.equal(r.cost, 0);
});
(0, node_test_1.default)('floating images reserve width on specific lines', () => {
    const words = [W('aaaa'), W('bbbb'), W('cccc')];
    const plain = (0, index_1.layout)(base(words, 9));
    strict_1.default.equal(plain.cost, 0); // "aaaa bbbb" fits exactly
    const withImg = (0, index_1.layout)(base(words, 9, { images: [{ line: 1, width: 2 }] }));
    strict_1.default.equal(withImg.ok, true);
    // line 1 now has only 7 units: one word (slack 3) -> cost 9, rest free
    strict_1.default.equal(withImg.cost, 9);
    strict_1.default.equal(withImg.lines[0].reserved, 2);
    strict_1.default.deepEqual(withImg.lines.map((l) => l.text), ['aaaa', 'bbbb cccc']);
});
(0, node_test_1.default)('widow control: last line must have enough words', () => {
    const words = [W('aaaa'), W('bbbb'), W('cccc')];
    const r = (0, index_1.layout)(base(words, 9, { minLastLineWords: 2 }));
    strict_1.default.equal(r.ok, true);
    // "aaaa bbbb" / "cccc" is forbidden; best is "aaaa" / "bbbb cccc" (slack 5 -> 25)
    strict_1.default.equal(r.cost, 25);
    strict_1.default.deepEqual(r.lines.map((l) => l.text), ['aaaa', 'bbbb cccc']);
});
(0, node_test_1.default)('orphan control: unsatisfiable first-line minimum fails explicitly', () => {
    const words = [W('aaaaaaaa'), W('bbbb'), W('cccc')];
    const r = (0, index_1.layout)(base(words, 9, { minFirstLineWords: 2 }));
    strict_1.default.equal(r.ok, false);
    if (!r.ok)
        strict_1.default.equal(r.kind, 'infeasible');
});
(0, node_test_1.default)('keepWithNext creates an unbreakable region across words', () => {
    const glued = (0, index_1.layout)(base([W('aa', undefined, true), W('bb')], 3));
    strict_1.default.equal(glued.ok, false); // "aa bb" (5) cannot be split and overflows
    const free = (0, index_1.layout)(base([W('aa'), W('bb')], 3));
    strict_1.default.equal(free.ok, true);
    strict_1.default.equal(free.cost, 1);
});
(0, node_test_1.default)('empty paragraph is a trivial optimum', () => {
    const r = (0, index_1.layout)(base([], 10));
    strict_1.default.deepEqual(r, { ok: true, cost: 0, breaks: [], lines: [], hyphenations: 0 });
});
// ---------------------------------------------------------------------------
// Full-enumeration cross-check (全切分对照) on randomized short texts.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randomCase(rand) {
    const alphabet = 'abcde';
    const widths = {};
    for (const ch of alphabet)
        widths[ch] = 1 + Math.floor(rand() * 3);
    const wordCount = 1 + Math.floor(rand() * 6);
    const words = [];
    for (let i = 0; i < wordCount; i++) {
        const len = 1 + Math.floor(rand() * 5);
        let text = '';
        for (let k = 0; k < len; k++)
            text += alphabet[Math.floor(rand() * alphabet.length)];
        const softBreaks = [];
        for (let off = 1; off < len; off++)
            if (rand() < 0.3)
                softBreaks.push(off);
        words.push({
            text,
            ...(softBreaks.length ? { softBreaks } : {}),
            ...(rand() < 0.15 ? { keepWithNext: true } : {}),
        });
    }
    const images = [];
    for (let line = 1; line <= 3; line++) {
        if (rand() < 0.3)
            images.push({ line, width: 1 + Math.floor(rand() * 3) });
    }
    return {
        words,
        widths,
        spaceWidth: 1 + Math.floor(rand() * 2),
        hyphenWidth: Math.floor(rand() * 3),
        maxWidth: 6 + Math.floor(rand() * 13),
        maxHyphenations: Math.floor(rand() * 4),
        images,
        minFirstLineWords: 1 + Math.floor(rand() * 2),
        minLastLineWords: 1 + Math.floor(rand() * 2),
    };
}
(0, node_test_1.default)('DP matches full enumeration on randomized short texts', () => {
    let feasible = 0;
    let infeasible = 0;
    for (let seed = 1; seed <= 400; seed++) {
        const opts = randomCase(mulberry32(seed));
        const fast = (0, index_1.layout)(opts);
        const slow = (0, index_1.layoutBruteForce)(opts);
        strict_1.default.equal(fast.ok, slow.ok, `seed ${seed}: feasibility mismatch`);
        if (fast.ok && slow.ok) {
            feasible++;
            strict_1.default.equal(fast.cost, slow.cost, `seed ${seed}: cost mismatch`);
            strict_1.default.deepEqual(fast.breaks.map((b) => b.afterAtom), slow.breaks.map((b) => b.afterAtom), `seed ${seed}: certificate mismatch`);
            // certificate self-consistency
            const recomputed = fast.lines.slice(0, -1).reduce((s, l) => s + l.slack * l.slack, 0);
            strict_1.default.equal(recomputed, fast.cost, `seed ${seed}: certificate does not reproduce bound`);
            for (const line of fast.lines)
                strict_1.default.ok(line.slack >= 0, `seed ${seed}: overflow`);
        }
        else {
            infeasible++;
        }
    }
    strict_1.default.ok(feasible > 100, `too few feasible samples: ${feasible}`);
    strict_1.default.ok(infeasible > 10, `too few infeasible samples: ${infeasible}`);
});
(0, node_test_1.default)('larger paragraph (up to 40 words) stays correct and fast', () => {
    const words = [];
    for (let i = 0; i < 40; i++) {
        const len = 2 + (i % 5);
        words.push(W('x'.repeat(len), len > 3 ? [2] : undefined));
    }
    const widths = { x: 2 };
    const start = Date.now();
    const r = (0, index_1.layout)({ words, widths, spaceWidth: 1, hyphenWidth: 1, maxWidth: 30, maxHyphenations: 5 });
    strict_1.default.ok(Date.now() - start < 2000);
    strict_1.default.equal(r.ok, true);
    for (const line of r.lines)
        strict_1.default.ok(line.slack >= 0);
    strict_1.default.ok(r.hyphenations <= 5);
});
