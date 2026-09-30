import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dedupwin import DedupWin, MissingFieldError

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rec(rid, ts, key="k", val="v"):
    return {"id": rid, "key": key, "ts": ts, "val": val}


def reference(events):
    """Reference: stable sort by (ts, id), then keep first record per id."""
    out = []
    seen = set()
    for r in sorted(events, key=lambda r: (r["ts"], r["id"])):
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(r)
    return out


def run_cli(path, skew, ret):
    return subprocess.run(
        [sys.executable, "-m", "dedupwin", "--in", path,
         "--skew", str(skew), "--ret", str(ret)],
        capture_output=True, text=True, cwd=REPO_ROOT)


def write_jsonl(events):
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")
    return path


class TestPermutations(unittest.TestCase):
    """Acceptance 1: shuffled input matches sort-then-dedup reference."""

    def test_permutations_match_reference(self):
        base = [
            rec("id0", 100, "a", 1),
            rec("id1", 140, "b", 2),
            rec("id2", 120, "c", 3),
            rec("id3", 160, "d", 4),
            rec("id4", 110, "e", 5),
            rec("id5", 150, "f", 6),
            rec("id1", 140, "b", 2),   # exact duplicate
            rec("id2", 120, "c", 3),   # exact duplicate
        ]
        self.assertLessEqual(len(base), 10)
        rng = random.Random(20261001)
        perms = [list(base)]
        for _ in range(9):
            p = list(base)
            rng.shuffle(p)
            perms.append(p)
        for events in perms:
            dw = DedupWin(skew=1000, ret=1000)
            for e in events:
                dw.add(dict(e))
            self.assertEqual(dw.results(), reference(events))

    def test_same_ts_stable_by_input_order(self):
        # Same ts, different ids: ordered by id ascending.
        events = [rec("b", 5, "k1", "x"), rec("a", 5, "k2", "y"),
                  rec("c", 5, "k3", "z")]
        dw = DedupWin(skew=10, ret=10)
        for e in events:
            dw.add(e)
        self.assertEqual([r["id"] for r in dw.results()], ["a", "b", "c"])

    def test_full_tie_first_input_wins(self):
        # Identical (ts, id): first input record takes effect.
        dw = DedupWin(skew=10, ret=10)
        dw.add(rec("a", 5, "k", "first"))
        dw.add(rec("a", 5, "k", "second"))
        out = dw.results()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["val"], "first")

    def test_replay_deterministic(self):
        events = [rec("id%d" % (i % 4), 100 + i * 7, "k", i) for i in range(9)]
        path = write_jsonl(events)
        try:
            r1 = run_cli(path, 10000, 60000)
            r2 = run_cli(path, 10000, 60000)
        finally:
            os.unlink(path)
        self.assertEqual(r1.returncode, 0)
        self.assertEqual(r1.stdout, r2.stdout)


class TestConflicts(unittest.TestCase):
    """Acceptance 2: duplicate id with conflicting fields; first wins."""

    def test_conflict_first_wins(self):
        dw = DedupWin(skew=100, ret=100)
        dw.add(rec("a", 10, "k1", "first"))
        dw.add(rec("a", 12, "k2", "second"))
        self.assertEqual(dw.duplicates, 1)
        self.assertEqual(dw.conflicts, 1)
        out = dw.results()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["val"], "first")
        self.assertEqual(out[0]["key"], "k1")

    def test_identical_duplicate_no_conflict(self):
        dw = DedupWin(skew=100, ret=100)
        dw.add(rec("a", 10, "k", "v"))
        dw.add(rec("a", 10, "k", "v"))
        self.assertEqual(dw.duplicates, 1)
        self.assertEqual(dw.conflicts, 0)
        self.assertEqual(len(dw.results()), 1)


class TestEvictionBoundary(unittest.TestCase):
    """Acceptance 3: eviction boundary is exactly L - ret."""

    SKEW, RET = 10, 5

    def test_id_at_boundary_is_retained(self):
        # After b@20: max_ts=20, L=5, L-ret=0; id a max_ts == 0 == L-ret.
        dw = DedupWin(skew=self.SKEW, ret=self.RET)
        dw.add(rec("a", 0, "k", "first"))
        dw.add(rec("b", 20))
        self.assertIn("a", dw._state)
        dw.add(rec("a", 6, "k", "dup"))
        self.assertEqual(dw.duplicates, 1)
        self.assertEqual([r["id"] for r in dw.results()], ["a", "b"])

    def test_id_below_boundary_is_evicted(self):
        # After b@21: max_ts=21, L=6, L-ret=1; id a max_ts 0 < 1 -> evicted.
        dw = DedupWin(skew=self.SKEW, ret=self.RET)
        dw.add(rec("a", 0, "k", "first"))
        dw.add(rec("b", 21))
        self.assertNotIn("a", dw._state)
        self.assertEqual(dw.evicted, 1)
        dw.add(rec("a", 6, "k", "second"))
        self.assertEqual(dw.duplicates, 0)
        self.assertEqual([r["id"] for r in dw.results()], ["a", "a", "b"])


class TestLargeSkew(unittest.TestCase):
    """Acceptance 4: with large skew, late/future ids are not judged lost."""

    def test_future_id_within_skew_window_accepted(self):
        dw = DedupWin(skew=10000, ret=60000)
        dw.add(rec("a", 50000))
        self.assertEqual(dw.lower_bound, 50000 - 10000 - 60000)
        dw.add(rec("x", 0))  # far in the past but still >= L
        dw.add(rec("y", 30000))
        self.assertEqual(dw.dropped_late, 0)
        self.assertEqual([r["id"] for r in dw.results()], ["x", "y", "a"])

    def test_event_below_lower_bound_dropped(self):
        dw = DedupWin(skew=5, ret=5)
        dw.add(rec("a", 100))
        dw.add(rec("b", 50))  # L = 90, 50 < 90 -> too late
        self.assertEqual(dw.dropped_late, 1)
        self.assertEqual([r["id"] for r in dw.results()], ["a"])


class TestErrors(unittest.TestCase):
    def test_missing_id_raises(self):
        dw = DedupWin(skew=1, ret=1)
        with self.assertRaises(MissingFieldError):
            dw.add({"ts": 1})

    def test_missing_ts_raises(self):
        dw = DedupWin(skew=1, ret=1)
        with self.assertRaises(MissingFieldError):
            dw.add({"id": "a"})

    def test_cli_missing_field_exit2(self):
        path = write_jsonl([{"id": "a", "ts": 1}, {"id": "b"}])
        try:
            proc = run_cli(path, 10, 10)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("missing required field", proc.stderr)

    def test_negative_ts_is_bad(self):
        path = write_jsonl([rec("a", -1), rec("b", 5)])
        try:
            proc = run_cli(path, 10, 10)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("bad=1", proc.stderr)
        out = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual([r["id"] for r in out], ["b"])


class TestCliEndToEnd(unittest.TestCase):
    def test_cli_output_sorted_deduped(self):
        events = [
            rec("b", 30, "k", "keep-b"),
            rec("a", 10, "k", "keep-a"),
            rec("b", 30, "k", "keep-b"),  # exact dup
            rec("c", 20, "k", "keep-c"),
        ]
        path = write_jsonl(events)
        try:
            proc = run_cli(path, 10000, 60000)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 0)
        out = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual([(r["id"], r["ts"]) for r in out],
                         [("a", 10), ("c", 20), ("b", 30)])
        self.assertIn("duplicates=1", proc.stderr)


if __name__ == "__main__":
    unittest.main()
