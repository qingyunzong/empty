import { test } from "node:test";
import assert from "node:assert/strict";
import { expand, segmentText, sourceSpans } from "../src/expand.js";
import { decode, decodeSpans } from "../src/quote.js";
function vfs(entries) {
    return new Map(Object.entries(entries));
}
/** Segments must be contiguous, ordered, cover the text, and match sources. */
function assertProvenanceSound(exp, files) {
    let pos = 0;
    for (const seg of exp.segments) {
        assert.equal(seg.outStart, pos, "segments must be contiguous and ordered");
        const len = seg.end - seg.start;
        assert.ok(len > 0, "segments must be non-empty");
        assert.equal(exp.text.slice(pos, pos + len), segmentText(files, seg), `segment bytes must match source ${seg.file}:${seg.start}-${seg.end}`);
        pos += len;
    }
    assert.equal(pos, exp.text.length, "segments must cover the whole text");
}
test("simple include with byte-exact provenance", () => {
    const files = vfs({
        "main.rsp": "cc @flags.rsp -o out",
        "flags.rsp": "-Wall -O2",
    });
    const exp = expand("main.rsp", files);
    assert.equal(exp.text, "cc -Wall -O2 -o out");
    assert.deepEqual(decode(exp.text), ["cc", "-Wall", "-O2", "-o", "out"]);
    assertProvenanceSound(exp, files);
    // The argument -O2 must map back to flags.rsp, not main.rsp.
    const arg = decodeSpans(exp.text)[2];
    const spans = sourceSpans(exp, arg.start, arg.end);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].file, "flags.rsp");
    assert.equal(files.get("flags.rsp").slice(spans[0].start, spans[0].end), "-O2");
});
test("virtual file graph: diamond includes keep per-byte sources", () => {
    const files = vfs({
        "main.rsp": "cc @a.rsp @b.rsp",
        "a.rsp": "@common.rsp -A",
        "b.rsp": "@common.rsp -B",
        "common.rsp": "--std=c20",
    });
    const exp = expand("main.rsp", files);
    assert.equal(exp.text, "cc --std=c20 -A --std=c20 -B");
    assertProvenanceSound(exp, files);
    const args = decodeSpans(exp.text);
    // Both --std=c20 occurrences point at the same source span in common.rsp.
    const first = sourceSpans(exp, args[1].start, args[1].end);
    const second = sourceSpans(exp, args[3].start, args[3].end);
    assert.deepEqual(first.map((s) => [s.file, s.start, s.end]), [["common.rsp", 0, 9]]);
    assert.deepEqual(second.map((s) => [s.file, s.start, s.end]), [["common.rsp", 0, 9]]);
});
test("conditional branches select on the condition set", () => {
    const content = "base @if(debug) -g @else -O2 @endif end";
    const files = vfs({ "main.rsp": content });
    const dbg = expand("main.rsp", files, new Set(["debug"]));
    assert.deepEqual(decode(dbg.text), ["base", "-g", "end"]);
    assertProvenanceSound(dbg, files);
    const rel = expand("main.rsp", files, new Set());
    assert.deepEqual(decode(rel.text), ["base", "-O2", "end"]);
    assertProvenanceSound(rel, files);
});
test("negated and nested conditions", () => {
    const files = vfs({
        "main.rsp": "a @if(!nodebug) x @endif @if(a1) @if(a2) y @endif @endif z",
    });
    assert.deepEqual(decode(expand("main.rsp", files, new Set()).text), ["a", "x", "z"]);
    assert.deepEqual(decode(expand("main.rsp", files, new Set(["nodebug"])).text), ["a", "z"]);
    assert.deepEqual(decode(expand("main.rsp", files, new Set(["a1"])).text), ["a", "x", "z"]);
    assert.deepEqual(decode(expand("main.rsp", files, new Set(["a1", "a2"])).text), ["a", "x", "y", "z"]);
});
test("conditional includes come from different files per branch", () => {
    const files = vfs({
        "main.rsp": "tool @if(windows) @win.rsp @else @posix.rsp @endif done",
        "win.rsp": "/DWIN",
        "posix.rsp": "-DPOSIX",
    });
    const posix = expand("main.rsp", files, new Set());
    assert.deepEqual(decode(posix.text), ["tool", "-DPOSIX", "done"]);
    const win = expand("main.rsp", files, new Set(["windows"]));
    assert.deepEqual(decode(win.text), ["tool", "/DWIN", "done"]);
    assertProvenanceSound(win, files);
});
test("cross-file quoting: quotes, empty args and newlines survive includes", () => {
    const files = vfs({
        "q.rsp": "'it'\\''s' \"a b\" '' 'line1\nline2'",
        "main.rsp": "run @q.rsp done",
    });
    const exp = expand("main.rsp", files);
    assert.deepEqual(decode(exp.text), ["run", "it's", "a b", "", "line1\nline2", "done"]);
    assertProvenanceSound(exp, files);
    // The empty-string argument maps to the two quote bytes in q.rsp.
    const args = decodeSpans(exp.text);
    const emptyArg = args[3];
    assert.equal(emptyArg.value, "");
    const spans = sourceSpans(exp, emptyArg.start, emptyArg.end);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].file, "q.rsp");
    assert.equal(files.get("q.rsp").slice(spans[0].start, spans[0].end), "''");
    // The newline argument keeps its exact source bytes in q.rsp.
    const nlArg = args[4];
    const nlSpans = sourceSpans(exp, nlArg.start, nlArg.end);
    assert.equal(nlSpans.length, 1);
    assert.equal(files.get("q.rsp").slice(nlSpans[0].start, nlSpans[0].end), "'line1\nline2'");
});
test("literal @ forms: quoted, escaped, mid-token", () => {
    const files = vfs({ "main.rsp": "'@literal' \\@escaped a@b @" });
    assert.deepEqual(decode(expand("main.rsp", files).text), [
        "@literal",
        "@escaped",
        "a@b",
        "@",
    ]);
});
test("errors: cycle, missing file, bad conditionals, NUL", () => {
    const cyclic = vfs({ "a.rsp": "@b.rsp", "b.rsp": "@a.rsp" });
    assert.throws(() => expand("a.rsp", cyclic), /cycle/);
    const missing = vfs({ "main.rsp": "x @nope.rsp" });
    assert.throws(() => expand("main.rsp", missing), /not found/);
    const unterminated = vfs({ "main.rsp": "@if(x) y" });
    assert.throws(() => expand("main.rsp", unterminated), /unterminated @if/);
    const strayElse = vfs({ "main.rsp": "a @else b" });
    assert.throws(() => expand("main.rsp", strayElse), /@else without @if/);
    const strayEndif = vfs({ "main.rsp": "a @endif" });
    assert.throws(() => expand("main.rsp", strayEndif), /@endif without @if/);
    const dupElse = vfs({ "main.rsp": "@if(x) a @else b @else c @endif" });
    assert.throws(() => expand("main.rsp", dupElse), /duplicate @else/);
    const nul = vfs({ "main.rsp": "a\0b" });
    assert.throws(() => expand("main.rsp", nul), /NUL/);
});
test("missing include inside a skipped branch is not resolved", () => {
    const files = vfs({ "main.rsp": "@if(off) @missing.rsp @endif ok" });
    assert.deepEqual(decode(expand("main.rsp", files, new Set()).text), ["ok"]);
});
