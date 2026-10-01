"""Tests for the trimerge package.

The cross-check tests compare the DP-based alignment and the merge result
against an independent brute-force implementation that enumerates *all*
LCS match sequences for inputs of at most 8 lines.
"""

import os
import random
import subprocess
import sys
import tempfile
import unittest

from trimerge import (
    OURS_MARKER,
    SEPARATOR_MARKER,
    THEIRS_MARKER,
    join_lines,
    lcs_align,
    merge,
    split_lines,
)

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# Independent reference implementations (used only by the tests)
# ---------------------------------------------------------------------------

def brute_lcs(a, b):
    """Enumerate all LCS match sequences; return the lexicographically
    smallest one as a list of (a_index, b_index) pairs."""
    n, m = len(a), len(b)
    best_len = -1
    best = []

    def rec(i, j, acc):
        nonlocal best_len, best
        if len(acc) + min(n - i, m - j) < best_len:
            return
        if len(acc) > best_len:
            best_len = len(acc)
            best = [tuple(acc)]
        elif len(acc) == best_len:
            best.append(tuple(acc))
        for ii in range(i, n):
            for jj in range(j, m):
                if a[ii] == b[jj]:
                    rec(ii + 1, jj + 1, acc + [(ii, jj)])

    rec(0, 0, [])
    return list(min(best))


def reference_merge(base, ours, theirs):
    """Independent three-way merge built on the brute-force LCS."""
    mo = brute_lcs(base, ours)
    mt = brute_lcs(base, theirs)
    ours_match = {b: o for b, o in mo}
    theirs_match = {b: t for b, t in mt}

    out = []
    conflicts = 0
    anchors = [-1] + sorted(set(ours_match) & set(theirs_match)) + [len(base)]
    for left, right in zip(anchors, anchors[1:]):
        o_end = ours_match.get(right, len(ours))
        t_end = theirs_match.get(right, len(theirs))
        o_start = ours_match.get(left, -1)
        t_start = theirs_match.get(left, -1)
        b_seg = base[left + 1 : right]
        o_seg = ours[o_start + 1 : o_end]
        t_seg = theirs[t_start + 1 : t_end]
        if o_seg == b_seg and t_seg == b_seg:
            out.extend(b_seg)
        elif o_seg == b_seg:
            out.extend(t_seg)
        elif t_seg == b_seg:
            out.extend(o_seg)
        elif o_seg == t_seg:
            out.extend(o_seg)
        else:
            out.append(OURS_MARKER)
            out.extend(o_seg)
            out.append(SEPARATOR_MARKER)
            out.extend(t_seg)
            out.append(THEIRS_MARKER)
            conflicts += 1
        if right < len(base):
            out.append(base[right])
    return out, conflicts


def conflict_block(ours_seg, theirs_seg):
    return [OURS_MARKER] + ours_seg + [SEPARATOR_MARKER] + theirs_seg + [THEIRS_MARKER]


# ---------------------------------------------------------------------------
# Line splitting / joining
# ---------------------------------------------------------------------------

class SplitJoinTests(unittest.TestCase):
    def test_empty_text_is_empty_sequence(self):
        self.assertEqual(split_lines(""), [])

    def test_split_on_lf(self):
        self.assertEqual(split_lines("a\nb\nc"), ["a", "b", "c"])

    def test_trailing_lf_round_trips(self):
        for text in ["a\n", "a\nb\n", "\n", "a\n\nb", "x"]:
            self.assertEqual(join_lines(split_lines(text)), text)

    def test_empty_sequence_joins_to_empty(self):
        self.assertEqual(join_lines([]), "")


# ---------------------------------------------------------------------------
# LCS alignment
# ---------------------------------------------------------------------------

class LcsAlignTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(lcs_align(["a", "b", "c"], ["a", "x", "c"]),
                         [(0, 0), (2, 2)])

    def test_empty(self):
        self.assertEqual(lcs_align([], ["a"]), [])
        self.assertEqual(lcs_align(["a"], []), [])
        self.assertEqual(lcs_align([], []), [])

    def test_tie_breaks_to_lexicographically_smallest(self):
        # LCS length 1; candidates [(0, 1)] ("a") and [(1, 0)] ("b").
        self.assertEqual(lcs_align(["a", "b"], ["b", "a"]), [(0, 1)])

    def test_tie_breaks_with_repeated_lines(self):
        # Both "x" lines of base match; the earliest pair sequence wins.
        self.assertEqual(lcs_align(["x", "x"], ["x"]), [(0, 0)])

    def test_matches_brute_force_small_inputs(self):
        rng = random.Random(20241001)
        alphabet = ["p", "q", "r"]
        for _ in range(400):
            a = [rng.choice(alphabet) for _ in range(rng.randrange(9))]
            b = [rng.choice(alphabet) for _ in range(rng.randrange(9))]
            self.assertEqual(lcs_align(a, b), brute_lcs(a, b),
                             msg=f"a={a!r} b={b!r}")

    def test_matches_brute_force_exhaustive_tiny(self):
        alphabet = ["p", "q"]

        def seqs(limit):
            out = [[]]
            for _ in range(limit):
                out += [s + [c] for s in list(out) for c in alphabet]
            return [s for s in out if len(s) <= limit]

        for a in seqs(4):
            for b in seqs(4):
                self.assertEqual(lcs_align(a, b), brute_lcs(a, b),
                                 msg=f"a={a!r} b={b!r}")


# ---------------------------------------------------------------------------
# Merge semantics
# ---------------------------------------------------------------------------

class MergeTests(unittest.TestCase):
    def test_no_changes(self):
        merged, conflicts = merge(["a", "b"], ["a", "b"], ["a", "b"])
        self.assertEqual((merged, conflicts), (["a", "b"], 0))

    def test_non_overlapping_changes_merge_cleanly(self):
        base = ["one", "two", "three"]
        ours = ["ONE", "two", "three"]
        theirs = ["one", "two", "THREE"]
        merged, conflicts = merge(base, ours, theirs)
        self.assertEqual(merged, ["ONE", "two", "THREE"])
        self.assertEqual(conflicts, 0)

    def test_insert_before_line_other_side_deletes_that_line(self):
        # The insertion gap and the deleted line share one base region
        # (b is unmatched in theirs), so this is a conflict -- matching
        # git merge-file / diff3 behaviour.
        base = ["a", "b", "c"]
        ours = ["a", "x", "b", "c"]   # insert x before b
        theirs = ["a", "c"]           # delete b
        merged, conflicts = merge(base, ours, theirs)
        self.assertEqual(merged,
                         ["a"] + conflict_block(["x", "b"], []) + ["c"])
        self.assertEqual(conflicts, 1)

    def test_insert_and_delete_truly_disjoint(self):
        base = ["a", "b", "c", "d"]
        ours = ["a", "b", "x", "c", "d"]  # insert x after b
        theirs = ["a", "b", "c"]          # delete d
        merged, conflicts = merge(base, ours, theirs)
        self.assertEqual(merged, ["a", "b", "x", "c"])
        self.assertEqual(conflicts, 0)

    def test_same_line_modified_both_sides_conflicts(self):
        merged, conflicts = merge(["a"], ["b"], ["c"])
        self.assertEqual(merged, conflict_block(["b"], ["c"]))
        self.assertEqual(conflicts, 1)

    def test_same_change_both_sides_is_clean(self):
        merged, conflicts = merge(["a"], ["b"], ["b"])
        self.assertEqual((merged, conflicts), (["b"], 0))

    def test_modify_vs_delete_same_line_conflicts(self):
        merged, conflicts = merge(["a", "victim", "z"],
                                  ["a", "changed", "z"],
                                  ["a", "z"])
        self.assertEqual(merged, ["a"] + conflict_block(["changed"], []) + ["z"])
        self.assertEqual(conflicts, 1)

    def test_delete_vs_delete_same_line_is_clean(self):
        merged, conflicts = merge(["a", "b"], ["a"], ["a"])
        self.assertEqual((merged, conflicts), (["a"], 0))

    def test_empty_base_same_insertion_adopted(self):
        merged, conflicts = merge([], ["x", "y"], ["x", "y"])
        self.assertEqual((merged, conflicts), (["x", "y"], 0))

    def test_empty_base_different_insertions_conflict(self):
        merged, conflicts = merge([], ["ours"], ["theirs"])
        self.assertEqual(merged, conflict_block(["ours"], ["theirs"]))
        self.assertEqual(conflicts, 1)

    def test_empty_base_one_side_inserts(self):
        merged, conflicts = merge([], ["new"], [])
        self.assertEqual((merged, conflicts), (["new"], 0))
        merged, conflicts = merge([], [], ["new"])
        self.assertEqual((merged, conflicts), (["new"], 0))

    def test_all_empty(self):
        merged, conflicts = merge([], [], [])
        self.assertEqual((merged, conflicts), ([], 0))

    def test_same_gap_same_insertion_adopted(self):
        base = ["a", "b"]
        merged, conflicts = merge(base, ["a", "new", "b"], ["a", "new", "b"])
        self.assertEqual((merged, conflicts), (["a", "new", "b"], 0))

    def test_same_gap_different_insertions_conflict(self):
        base = ["a", "b"]
        merged, conflicts = merge(base, ["a", "x", "b"], ["a", "y", "b"])
        self.assertEqual(merged, ["a"] + conflict_block(["x"], ["y"]) + ["b"])
        self.assertEqual(conflicts, 1)

    def test_multiple_regions(self):
        base = ["1", "2", "3", "4", "5"]
        ours = ["1", "two", "3", "4", "5", "6"]
        theirs = ["1", "2", "3", "four", "5"]
        merged, conflicts = merge(base, ours, theirs)
        self.assertEqual(merged, ["1", "two", "3", "four", "5", "6"])
        self.assertEqual(conflicts, 0)


# ---------------------------------------------------------------------------
# Cross-check against the independent brute-force reference (<= 8 lines)
# ---------------------------------------------------------------------------

class CrossCheckTests(unittest.TestCase):
    def check(self, base, ours, theirs):
        expected = reference_merge(base, ours, theirs)
        actual = merge(base, ours, theirs)
        self.assertEqual(actual, expected,
                         msg=f"base={base!r} ours={ours!r} theirs={theirs!r}")
        # Marker sanity: conflict count matches emitted marker blocks.
        self.assertEqual(actual[1] > 0,
                         OURS_MARKER in actual[0])
        self.assertEqual(actual[0].count(OURS_MARKER), actual[1])
        self.assertEqual(actual[0].count(THEIRS_MARKER), actual[1])

    def test_exhaustive_tiny(self):
        alphabet = ["p", "q"]
        seqs = [[]]
        for _ in range(3):
            seqs += [s + [c] for s in list(seqs) for c in alphabet]
        seqs = [s for s in seqs if len(s) <= 3]
        for base in seqs:
            for ours in seqs:
                for theirs in seqs:
                    self.check(base, ours, theirs)

    def test_random_up_to_8_lines(self):
        rng = random.Random(987654321)
        alphabet = ["a", "b", "c"]
        for _ in range(300):
            base = [rng.choice(alphabet) for _ in range(rng.randrange(9))]
            ours = [rng.choice(alphabet) for _ in range(rng.randrange(9))]
            theirs = [rng.choice(alphabet) for _ in range(rng.randrange(9))]
            self.check(base, ours, theirs)

    def test_random_edits_up_to_8_lines(self):
        # More realistic: derive ours/theirs from base by random edits.
        rng = random.Random(1357924680)
        alphabet = ["a", "b", "c", "d"]

        def mutate(lines):
            lines = list(lines)
            for _ in range(rng.randrange(4)):
                op = rng.randrange(3)
                if op == 0 and lines:
                    lines[rng.randrange(len(lines))] = rng.choice(alphabet)
                elif op == 1 and lines:
                    del lines[rng.randrange(len(lines))]
                else:
                    lines.insert(rng.randrange(len(lines) + 1),
                                 rng.choice(alphabet))
            return lines[:8]

        for _ in range(300):
            base = [rng.choice(alphabet) for _ in range(rng.randrange(9))]
            self.check(base, mutate(base), mutate(base))


# ---------------------------------------------------------------------------
# CLI end-to-end
# ---------------------------------------------------------------------------

class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def path(self, name):
        return os.path.join(self.dir, name)

    def write(self, name, content):
        with open(self.path(name), "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
        return self.path(name)

    def write_bytes(self, name, content):
        with open(self.path(name), "wb") as fh:
            fh.write(content)
        return self.path(name)

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "trimerge", *args],
            cwd=REPO_ROOT, capture_output=True, text=True,
        )

    def read(self, name):
        with open(self.path(name), "r", encoding="utf-8", newline="") as fh:
            return fh.read()

    def test_clean_merge_exit_0(self):
        base = self.write("base", "one\ntwo\nthree\n")
        ours = self.write("ours", "ONE\ntwo\nthree\n")
        theirs = self.write("theirs", "one\ntwo\nTHREE\n")
        out = self.path("merged")
        proc = self.run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.read("merged"), "ONE\ntwo\nTHREE\n")

    def test_conflict_exit_1_with_markers(self):
        base = self.write("base", "a\n")
        ours = self.write("ours", "b\n")
        theirs = self.write("theirs", "c\n")
        out = self.path("merged")
        proc = self.run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertEqual(
            self.read("merged"),
            "<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\n",
        )

    def test_empty_base_same_insertion_clean(self):
        base = self.write("base", "")
        ours = self.write("ours", "x\ny\n")
        theirs = self.write("theirs", "x\ny\n")
        out = self.path("merged")
        proc = self.run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.read("merged"), "x\ny\n")

    def test_empty_base_different_insertion_conflict(self):
        base = self.write("base", "")
        ours = self.write("ours", "ours\n")
        theirs = self.write("theirs", "theirs\n")
        out = self.path("merged")
        proc = self.run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        # "ours\n" splits to ["ours", ""]; with an empty base there are no
        # anchors, so the trailing empty line is part of both segments.
        self.assertEqual(
            self.read("merged"),
            "<<<<<<< ours\nours\n\n=======\ntheirs\n\n>>>>>>> theirs",
        )

    def test_missing_input_exit_2_no_output(self):
        ours = self.write("ours", "a\n")
        theirs = self.write("theirs", "a\n")
        out = self.path("merged")
        proc = self.run_cli(self.path("nope"), ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))

    def test_invalid_utf8_exit_2_no_output(self):
        base = self.write_bytes("base", b"\xff\xfe invalid")
        ours = self.write("ours", "a\n")
        theirs = self.write("theirs", "a\n")
        out = self.path("merged")
        proc = self.run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))

    def test_usage_error_exit_2_no_output(self):
        out = self.path("merged")
        proc = self.run_cli("-o", out)  # missing positional arguments
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))

    def test_unwritable_output_exit_2(self):
        base = self.write("base", "a\n")
        ours = self.write("ours", "a\n")
        theirs = self.write("theirs", "a\n")
        out = self.path(os.path.join("missing-dir", "merged"))
        proc = self.run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))


if __name__ == "__main__":
    unittest.main()
