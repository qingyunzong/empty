import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyPatches, enumerateOccurrences, locate, revert, SMALL_STRING_THRESHOLD, } from "../src/index.js";
const BASELINE = [
    "alpha beta gamma",
    "delta epsilon zeta",
    "eta theta iota",
].join("\n");
describe("locate", () => {
    test("unique match reports chosenOffset and evidence", () => {
        const ev = locate(BASELINE, { old: "epsilon", new: "EPSILON" });
        assert.equal(ev.status, "unique");
        assert.equal(ev.matchCount, 1);
        assert.equal(ev.chosenOffset, BASELINE.indexOf("epsilon"));
        assert.equal(ev.candidates.length, 1);
        assert.match(ev.candidates[0].excerpt, />>>epsilon<<</);
    });
    test("multiple matches are ambiguous, never guessed, all enumerated", () => {
        const target = "foo bar foo baz foo";
        const ev = locate(target, { old: "foo", new: "qux" });
        assert.equal(ev.status, "ambiguous");
        assert.equal(ev.matchCount, 3);
        assert.deepEqual(ev.candidates.map((c) => c.offset), [0, 8, 16]);
        assert.equal(ev.chosenOffset, undefined);
    });
    test("missing content is not-found", () => {
        const ev = locate(BASELINE, { old: "omega", new: "OMEGA" });
        assert.equal(ev.status, "not-found");
        assert.equal(ev.matchCount, 0);
    });
    test("hint is evidence only and does not disambiguate", () => {
        const target = "foo bar foo";
        const ev = locate(target, { old: "foo", new: "qux", hint: 8 });
        assert.equal(ev.status, "ambiguous");
        assert.equal(ev.hintMatched, true);
        assert.equal(ev.chosenOffset, undefined);
    });
    test("small strings are flagged and occurrences enumerated with overlap", () => {
        const ev = locate("aaaa", { old: "aa", new: "b" });
        assert.equal(ev.smallString, true);
        assert.equal(ev.oldLength <= SMALL_STRING_THRESHOLD, true);
        assert.deepEqual(ev.candidates.map((c) => c.offset), [0, 1, 2]);
    });
});
describe("enumerateOccurrences", () => {
    test("finds overlapping occurrences", () => {
        assert.deepEqual(enumerateOccurrences("aaaa", "aa"), [0, 1, 2]);
    });
    test("empty needle yields nothing", () => {
        assert.deepEqual(enumerateOccurrences("abc", ""), []);
    });
});
describe("applyPatches", () => {
    test("applies a single patch and emits inverse + evidence", () => {
        const result = applyPatches(BASELINE, [
            { id: "p1", old: "epsilon", new: "EPSILON" },
        ]);
        assert.equal(result.ok, true);
        const ok = result;
        assert.equal(ok.output, BASELINE.replace("epsilon", "EPSILON"));
        assert.equal(ok.inverse.length, 1);
        const inv = ok.inverse[0];
        assert.equal(inv.id, "p1");
        assert.equal(inv.old, "EPSILON");
        assert.equal(inv.new, "epsilon");
        assert.equal(ok.output.slice(inv.offset, inv.offset + inv.old.length), "EPSILON");
        assert.equal(ok.evidence[0].status, "unique");
    });
    test("locates by original content when the target already drifted", () => {
        // Target differs from baseline before the anchor: offsets have shifted.
        const target = BASELINE.replace("alpha", "ALPHA-LONGER");
        const result = applyPatches(target, [
            { old: "epsilon", new: "EPSILON", hint: BASELINE.indexOf("epsilon") },
        ]);
        assert.equal(result.ok, true);
        const ok = result;
        assert.equal(ok.output, target.replace("epsilon", "EPSILON"));
        const ev = ok.evidence[0];
        assert.equal(ev.hintMatched, false); // baseline offset no longer valid
        assert.equal(ev.chosenOffset, target.indexOf("epsilon")); // found by content
    });
    test("ambiguity in any patch fails the whole batch atomically", () => {
        const target = "foo bar foo";
        const result = applyPatches(target, [
            { id: "good", old: "bar", new: "BAR" },
            { id: "bad", old: "foo", new: "qux" },
        ]);
        assert.equal(result.ok, false);
        if (result.ok)
            return;
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0], /patch "bad": ambiguous, 2 matches at offsets 0, 8/);
        assert.match(result.errors[0], /refusing to guess/);
        // Evidence covers both patches; nothing was applied (no output field).
        assert.equal(result.evidence.length, 2);
        assert.equal("output" in result, false);
    });
    test("not-found fails atomically even when other patches are valid", () => {
        const result = applyPatches(BASELINE, [
            { old: "epsilon", new: "EPSILON" },
            { old: "omega", new: "OMEGA" },
        ]);
        assert.equal(result.ok, false);
        if (result.ok)
            return;
        assert.match(result.errors[0], /not found/);
    });
    test("applies multiple patches atomically with shifted inverse offsets", () => {
        const patches = [
            { id: "a", old: "beta", new: "BETA-BETA" },
            { id: "b", old: "theta", new: "THETA" },
        ];
        const result = applyPatches(BASELINE, patches);
        assert.equal(result.ok, true);
        const ok = result;
        assert.equal(ok.output, BASELINE.replace("beta", "BETA-BETA").replace("theta", "THETA"));
        // Inverse offsets are in output coordinates.
        for (const inv of ok.inverse) {
            assert.equal(ok.output.slice(inv.offset, inv.offset + inv.old.length), inv.old);
        }
        // Reverting restores the original target exactly.
        const back = revert(ok.output, ok.inverse);
        assert.equal(back.ok, true);
        assert.equal(back.output, BASELINE);
    });
    test("overlapping located ranges are rejected", () => {
        const result = applyPatches("abcdefghij", [
            { id: "x", old: "cdef", new: "X" },
            { id: "y", old: "efgh", new: "Y" },
        ]);
        assert.equal(result.ok, false);
        if (result.ok)
            return;
        assert.match(result.errors[0], /overlap/);
    });
    test("empty old is rejected", () => {
        const result = applyPatches(BASELINE, [{ old: "", new: "x" }]);
        assert.equal(result.ok, false);
        if (result.ok)
            return;
        assert.match(result.errors[0], /non-empty/);
    });
    test("small repeated string: ambiguity evidence enumerates every candidate", () => {
        const target = "ab ab ab";
        const result = applyPatches(target, [{ id: "tiny", old: "ab", new: "AB" }]);
        assert.equal(result.ok, false);
        if (result.ok)
            return;
        const ev = result.evidence[0];
        assert.equal(ev.smallString, true);
        assert.equal(ev.matchCount, 3);
        assert.deepEqual(ev.candidates.map((c) => c.offset), [0, 3, 6]);
        for (const c of ev.candidates) {
            assert.match(c.excerpt, />>>ab<<</);
        }
    });
    test("adding context to old resolves a repeated small string", () => {
        const target = "ab ab ab";
        const result = applyPatches(target, [{ old: "b ab ab", new: "B AB AB" }]);
        assert.equal(result.ok, true);
        assert.equal(result.output, "aB AB AB");
    });
});
