"""Tests for the trimerge package and its CLI."""

from __future__ import annotations

import itertools
import os
import random
import subprocess
import sys
import tempfile
import unittest

from trimerge import (
    CONFLICT_OURS,
    CONFLICT_SEP,
    CONFLICT_THEIRS,
    join_lines,
    lcs_alignment,
    merge_lines,
    split_lines,
)

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# Independent reference implementations (brute force, used for cross-checks)
# ---------------------------------------------------------------------------

def brute_lcs(a, b):
    """Enumerate every common-subsequence matching; return the longest,
    lexicographically smallest sequence of matched index pairs."""
    best = []

    def rec(i, j, acc):
        nonlocal best
        if len(acc) > len(best) or (len(acc) == len(best) and acc < best):
            best = list(acc)
        for x in range(i, len(a)):
            for y in range(j, len(b)):
                if a[x] == b[y]:
                    rec(x + 1, y + 1, acc + [(x, y)])

    rec(0, 0, [])
    return best


def reference_merge(base, ours, theirs):
    """Independent 3-way merge built on the brute-force alignment."""
    mo = dict(brute_lcs(base, ours))
    mt = dict(brute_lcs(base, theirs))
    anchors = sorted(set(mo) & set(mt))
    out = []
    conflicts = 0
    b_lo = o_lo = t_lo = 0
    for b in anchors + [len(base)]:
        o_hi = mo[b] if b in mo else len(ours)
        t_hi = mt[b] if b in mt else len(theirs)
        b_seg = base[b_lo:b]
        o_seg = ours[o_lo:o_hi]
        t_seg = theirs[t_lo:t_hi]
        if o_seg == b_seg:
            out.extend(t_seg)
        elif t_seg == b_seg or o_seg == t_seg:
            out.extend(o_seg)
        else:
            conflicts += 1
            out += [CONFLICT_OURS] + o_seg + [CONFLICT_SEP] + t_seg
            out += [CONFLICT_THEIRS]
        if b in mo:
            out.append(base[b])
            b_lo = b + 1
            o_lo = mo[b] + 1
            t_lo = mt[b] + 1
    return out, conflicts


# ---------------------------------------------------------------------------
# Unit tests: line splitting
# ---------------------------------------------------------------------------

class SplitJoinTests(unittest.TestCase):
    def test_empty_text_is_empty_sequence(self):
        self.assertEqual(split_lines(""), [])
        self.assertEqual(join_lines([]), "")

    def test_roundtrip(self):
        for text in ["a", "a\nb", "a\nb\n", "\n", "a\n\nb"]:
            self.assertEqual(join_lines(split_lines(text)), text)


# ---------------------------------------------------------------------------
# Unit tests: LCS alignment determinism
# ---------------------------------------------------------------------------

class LcsAlignmentTests(unittest.TestCase):
    def test_identical(self):
        self.assertEqual(lcs_alignment(["a", "b"], ["a", "b"]), [(0, 0), (1, 1)])

    def test_disjoint(self):
        self.assertEqual(lcs_alignment(["a"], ["b"]), [])

    def test_tie_breaks_to_lexicographically_smallest(self):
        # "a" appears twice on each side; (0, 0) is the smallest match.
        self.assertEqual(lcs_alignment(["a", "a"], ["a", "a"]), [(0, 0), (1, 1)])
        # Two equal-length options: [(0, 1)] vs [(1, 0)] -> pick [(0, 1)].
        self.assertEqual(lcs_alignment(["x", "a"], ["a", "x"]), [(0, 1)])

    def test_against_brute_force_small(self):
        alpha = ["a", "b"]
        for n in range(5):
            for m in range(5):
                for a in itertools.product(alpha, repeat=n):
                    for b in itertools.product(alpha, repeat=m):
                        self.assertEqual(
                            lcs_alignment(list(a), list(b)),
                            brute_lcs(list(a), list(b)),
                            msg=f"a={a} b={b}",
                        )

    def test_against_brute_force_random_up_to_8(self):
        rng = random.Random(20261001)
        alpha = ["a", "b", "c"]
        for _ in range(400):
            a = [rng.choice(alpha) for _ in range(rng.randint(0, 8))]
            b = [rng.choice(alpha) for _ in range(rng.randint(0, 8))]
            self.assertEqual(lcs_alignment(a, b), brute_lcs(a, b),
                             msg=f"a={a} b={b}")


# ---------------------------------------------------------------------------
# Unit tests: merge semantics
# ---------------------------------------------------------------------------

class MergeTests(unittest.TestCase):
    def test_non_overlapping_edits_merge_cleanly(self):
        base = ["one", "two", "three"]
        ours = ["ONE", "two", "three"]
        theirs = ["one", "two", "THREE"]
        merged, conflicts = merge_lines(base, ours, theirs)
        self.assertEqual(conflicts, 0)
        self.assertEqual(merged, ["ONE", "two", "THREE"])

    def test_same_line_modified_by_both_conflicts(self):
        merged, conflicts = merge_lines(["a"], ["b"], ["c"])
        self.assertEqual(conflicts, 1)
        self.assertEqual(
            merged,
            [CONFLICT_OURS, "b", CONFLICT_SEP, "c", CONFLICT_THEIRS],
        )

    def test_same_change_on_both_sides_is_clean(self):
        merged, conflicts = merge_lines(["a"], ["b"], ["b"])
        self.assertEqual(conflicts, 0)
        self.assertEqual(merged, ["b"])

    def test_modify_vs_delete_same_line_conflicts(self):
        merged, conflicts = merge_lines(["a", "b"], ["a", "B"], ["a"])
        self.assertEqual(conflicts, 1)
        self.assertEqual(
            merged,
            ["a", CONFLICT_OURS, "B", CONFLICT_SEP, CONFLICT_THEIRS],
        )

    def test_one_side_delete_is_adopted(self):
        merged, conflicts = merge_lines(["a", "b", "c"], ["a", "c"],
                                        ["a", "b", "c"])
        self.assertEqual(conflicts, 0)
        self.assertEqual(merged, ["a", "c"])

    def test_empty_base_same_insertions(self):
        merged, conflicts = merge_lines([], ["x", "y"], ["x", "y"])
        self.assertEqual(conflicts, 0)
        self.assertEqual(merged, ["x", "y"])

    def test_empty_base_different_insertions_conflict(self):
        merged, conflicts = merge_lines([], ["x"], ["y"])
        self.assertEqual(conflicts, 1)
        self.assertEqual(
            merged,
            [CONFLICT_OURS, "x", CONFLICT_SEP, "y", CONFLICT_THEIRS],
        )

    def test_insertions_in_same_gap(self):
        merged, conflicts = merge_lines(["a"], ["a", "new"], ["a", "new"])
        self.assertEqual(conflicts, 0)
        self.assertEqual(merged, ["a", "new"])

    def test_against_reference_merge_exhaustive_tiny(self):
        alpha = ["a", "b"]
        seqs = [list(p) for n in range(4) for p in itertools.product(alpha, repeat=n)]
        for base, ours, theirs in itertools.product(seqs, repeat=3):
            self.assertEqual(
                merge_lines(base, ours, theirs),
                reference_merge(base, ours, theirs),
                msg=f"base={base} ours={ours} theirs={theirs}",
            )

    def test_against_reference_merge_random_up_to_8(self):
        rng = random.Random(1234567)
        alpha = ["a", "b", "c"]
        for _ in range(500):
            base = [rng.choice(alpha) for _ in range(rng.randint(0, 8))]
            ours = [rng.choice(alpha) for _ in range(rng.randint(0, 8))]
            theirs = [rng.choice(alpha) for _ in range(rng.randint(0, 8))]
            self.assertEqual(
                merge_lines(base, ours, theirs),
                reference_merge(base, ours, theirs),
                msg=f"base={base} ours={ours} theirs={theirs}",
            )


# ---------------------------------------------------------------------------
# CLI tests
# ---------------------------------------------------------------------------

class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def _write(self, name, text=None, raw=None):
        path = os.path.join(self.dir, name)
        if raw is not None:
            with open(path, "wb") as fh:
                fh.write(raw)
        else:
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
        return path

    def _run(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "trimerge", *argv],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_clean_merge_exit_0(self):
        base = self._write("base", "one\ntwo\nthree\n")
        ours = self._write("ours", "ONE\ntwo\nthree\n")
        theirs = self._write("theirs", "one\ntwo\nTHREE\n")
        out = os.path.join(self.dir, "merged")
        proc = self._run(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(out, encoding="utf-8", newline="") as fh:
            self.assertEqual(fh.read(), "ONE\ntwo\nTHREE\n")

    def test_conflict_exit_1_and_markers(self):
        base = self._write("base", "a\n")
        ours = self._write("ours", "b\n")
        theirs = self._write("theirs", "c\n")
        out = os.path.join(self.dir, "merged")
        proc = self._run(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        with open(out, encoding="utf-8", newline="") as fh:
            self.assertEqual(
                fh.read(),
                "<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\n",
            )

    def test_empty_base_same_insert_exit_0(self):
        base = self._write("base", "")
        ours = self._write("ours", "x\ny\n")
        theirs = self._write("theirs", "x\ny\n")
        out = os.path.join(self.dir, "merged")
        proc = self._run(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(out, encoding="utf-8", newline="") as fh:
            self.assertEqual(fh.read(), "x\ny\n")

    def test_empty_base_different_insert_exit_1(self):
        base = self._write("base", "")
        ours = self._write("ours", "x\n")
        theirs = self._write("theirs", "y\n")
        out = os.path.join(self.dir, "merged")
        proc = self._run(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 1, proc.stderr)

    def test_usage_error_exit_2_no_output(self):
        out = os.path.join(self.dir, "merged")
        proc = self._run("onlyone", "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))

    def test_missing_input_exit_2_no_output(self):
        base = os.path.join(self.dir, "nonexistent")
        ours = self._write("ours", "a\n")
        theirs = self._write("theirs", "a\n")
        out = os.path.join(self.dir, "merged")
        proc = self._run(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))

    def test_decode_error_exit_2_no_output(self):
        base = self._write("base", raw=b"\xff\xfe invalid utf-8")
        ours = self._write("ours", "a\n")
        theirs = self._write("theirs", "a\n")
        out = os.path.join(self.dir, "merged")
        proc = self._run(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))


if __name__ == "__main__":
    unittest.main()
