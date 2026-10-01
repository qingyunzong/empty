import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from dedupwin import DedupWin, MissingFieldError

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def reference(events, skew, ret):
    """Reference: sort by (ts, id, input-order), then dedup first-wins,
    then keep records with ts >= L = max_ts - skew - ret."""
    valid = [(i, e) for i, e in enumerate(events) if e["ts"] >= 0]
    if not valid:
        return []
    max_ts = max(e["ts"] for _, e in valid)
    lower = max_ts - skew - ret
    valid.sort(key=lambda p: (p[1]["ts"], p[1]["id"], p[0]))
    seen = set()
    out = []
    for _, e in valid:
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        if e["ts"] >= lower:
            out.append(e)
    return out


def run_core(events, skew, ret):
    dwin = DedupWin(skew, ret)
    for e in events:
        dwin.add(e)
    return dwin


def make_events():
    """10 events, unique (ts, id) pairs; 'dup'/'late' have two copies with
    distinct ts and distinct val so the winner is permutation-independent."""
    return [
        {"id": "a", "key": "k1", "ts": 10, "val": "a1"},
        {"id": "b", "key": "k1", "ts": 4, "val": "b1"},
        {"id": "c", "key": "k2", "ts": 27, "val": "c1"},
        {"id": "dup", "key": "k3", "ts": 15, "val": "first"},
        {"id": "dup", "key": "k3", "ts": 33, "val": "second"},
        {"id": "e", "key": "k2", "ts": 8, "val": "e1"},
        {"id": "late", "key": "k4", "ts": 20, "val": "early"},
        {"id": "late", "key": "k4", "ts": 41, "val": "later"},
        {"id": "g", "key": "k5", "ts": 1, "val": "g1"},
        {"id": "h", "key": "k5", "ts": 12, "val": "h1"},
    ]


class PermutationTest(unittest.TestCase):
    """Acceptance 1: shuffled input must match sort-then-dedup reference."""

    def check_perm(self, events, skew, ret):
        dwin = run_core(events, skew, ret)
        self.assertEqual(dwin.results(), reference(events, skew, ret))

    def test_exhaustive_small(self):
        events = make_events()[:6]
        for perm in itertools.permutations(events):
            self.check_perm(list(perm), skew=1000, ret=1000)

    def test_random_permutations_n10(self):
        base = make_events()
        self.assertLessEqual(len(base), 10)
        rng = random.Random(20261001)
        for _ in range(300):
            perm = base[:]
            rng.shuffle(perm)
            self.check_perm(perm, skew=1000, ret=1000)

    def test_reversed_and_rotations(self):
        base = make_events()
        self.check_perm(base[::-1], skew=1000, ret=1000)
        for k in range(len(base)):
            self.check_perm(base[k:] + base[:k], skew=1000, ret=1000)

    def test_lower_bound_filters_old_events(self):
        base = make_events()
        rng = random.Random(7)
        for _ in range(100):
            perm = base[:]
            rng.shuffle(perm)
            # tight skew/ret so L cuts off some old events
            self.check_perm(perm, skew=20, ret=5)


class ConflictTest(unittest.TestCase):
    """Acceptance 2: duplicate id with inconsistent fields -> first wins,
    conflict recorded."""

    def test_conflict_first_wins(self):
        dwin = run_core([
            {"id": "x", "key": "k", "ts": 10, "val": "a"},
            {"id": "x", "key": "k", "ts": 20, "val": "b"},
        ], skew=100, ret=100)
        self.assertEqual(dwin.duplicates, 1)
        self.assertEqual(dwin.conflicts, 1)
        self.assertEqual([r["val"] for r in dwin.results()], ["a"])

    def test_earlier_ts_wins_even_if_arriving_later(self):
        dwin = run_core([
            {"id": "x", "key": "k", "ts": 20, "val": "b"},
            {"id": "x", "key": "k", "ts": 10, "val": "a"},
        ], skew=100, ret=100)
        self.assertEqual(dwin.conflicts, 1)
        out = dwin.results()
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["ts"], out[0]["val"]), (10, "a"))

    def test_identical_duplicate_is_not_a_conflict(self):
        dwin = run_core([
            {"id": "x", "key": "k", "ts": 10, "val": "a"},
            {"id": "x", "key": "k", "ts": 20, "val": "a"},
        ], skew=100, ret=100)
        self.assertEqual(dwin.duplicates, 1)
        self.assertEqual(dwin.conflicts, 0)
        self.assertEqual(len(dwin.results()), 1)

    def test_same_ts_stable_by_input_order(self):
        dwin = run_core([
            {"id": "x", "key": "k", "ts": 10, "val": "first-in"},
            {"id": "x", "key": "k", "ts": 10, "val": "second-in"},
        ], skew=100, ret=100)
        self.assertEqual(dwin.conflicts, 1)
        self.assertEqual([r["val"] for r in dwin.results()], ["first-in"])


class EvictionBoundaryTest(unittest.TestCase):
    """Acceptance 3: id evicted iff id_max_ts < L - ret (strict)."""

    def test_boundary_exact_is_kept(self):
        dwin = DedupWin(skew=10, ret=20)
        dwin.add({"id": "a", "key": "k", "ts": 100, "val": 1})
        dwin.add({"id": "b", "key": "k", "ts": 150, "val": 1})
        # max_ts=150 -> L = 150-10-20 = 120 -> L-ret = 100 == a.max_ts
        self.assertEqual(dwin.eviction_bound(), 100)
        self.assertEqual(dwin.evicted, 0)
        self.assertIn("a", dwin._state)

    def test_one_below_boundary_is_evicted(self):
        dwin = DedupWin(skew=10, ret=20)
        dwin.add({"id": "a", "key": "k", "ts": 100, "val": 1})
        dwin.add({"id": "b", "key": "k", "ts": 151, "val": 1})
        # max_ts=151 -> L-ret = 101 > 100 -> evict a
        self.assertEqual(dwin.eviction_bound(), 101)
        self.assertEqual(dwin.evicted, 1)
        self.assertNotIn("a", dwin._state)

    def test_evicted_winner_never_emitted(self):
        dwin = DedupWin(skew=10, ret=20)
        dwin.add({"id": "a", "key": "k", "ts": 100, "val": 1})
        dwin.add({"id": "b", "key": "k", "ts": 1000, "val": 1})
        self.assertEqual(dwin.evicted, 1)
        self.assertEqual([r["id"] for r in dwin.results()], ["b"])


class LargeSkewTest(unittest.TestCase):
    """Acceptance 4: with large skew, absent ids are never declared lost;
    late duplicates still dedup and late new ids still emit."""

    def test_large_skew_keeps_state_and_output(self):
        skew = 10 ** 9
        dwin = run_core([
            {"id": "a", "key": "k", "ts": 5, "val": "orig"},
            {"id": "z", "key": "k", "ts": 1_000_000, "val": "far"},
            # duplicate of 'a' long after max_ts advanced: must still dedup
            {"id": "a", "key": "k", "ts": 7, "val": "copy"},
            # brand-new id with tiny ts arriving late: must still emit
            {"id": "new", "key": "k", "ts": 3, "val": "late-new"},
        ], skew=skew, ret=10)
        self.assertEqual(dwin.evicted, 0)
        self.assertEqual(dwin.duplicates, 1)
        out = dwin.results()
        self.assertEqual([r["id"] for r in out], ["new", "a", "z"])
        self.assertEqual(out[1]["val"], "orig")

    def test_lower_bound_moves_only_with_max_ts(self):
        dwin = DedupWin(skew=10 ** 9, ret=10)
        dwin.add({"id": "a", "key": "k", "ts": 5, "val": 1})
        self.assertLess(dwin.lower_bound(), 0)
        self.assertEqual([r["id"] for r in dwin.results()], ["a"])


class ErrorHandlingTest(unittest.TestCase):
    def test_missing_id_raises(self):
        dwin = DedupWin(1, 1)
        with self.assertRaises(MissingFieldError):
            dwin.add({"key": "k", "ts": 1, "val": 1})

    def test_missing_ts_raises(self):
        dwin = DedupWin(1, 1)
        with self.assertRaises(MissingFieldError):
            dwin.add({"id": "a", "key": "k", "val": 1})

    def test_negative_ts_is_bad(self):
        dwin = run_core([
            {"id": "a", "key": "k", "ts": -5, "val": "neg"},
            {"id": "b", "key": "k", "ts": 5, "val": "ok"},
        ], skew=10, ret=10)
        self.assertEqual(dwin.bad, 1)
        self.assertEqual([r["id"] for r in dwin.results()], ["b"])

    def test_empty_input(self):
        dwin = DedupWin(10, 10)
        self.assertEqual(dwin.results(), [])
        self.assertIsNone(dwin.lower_bound())


class CliTest(unittest.TestCase):
    def run_cli(self, lines, skew=10000, ret=60000):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".jsonl", delete=False, encoding="utf-8") as fh:
            for line in lines:
                fh.write(line if isinstance(line, str) else json.dumps(line))
                fh.write("\n")
            path = fh.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "dedupwin", "--in", path,
                 "--skew", str(skew), "--ret", str(ret)],
                capture_output=True, text=True, cwd=REPO_ROOT)
        finally:
            os.unlink(path)

    def test_cli_end_to_end(self):
        events = make_events()
        rng = random.Random(42)
        rng.shuffle(events)
        proc = self.run_cli(events)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        got = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(got, reference(events, 10000, 60000))
        stats = json.loads(proc.stderr.strip())
        self.assertEqual(stats["duplicates"], 2)
        self.assertEqual(stats["conflicts"], 2)

    def test_cli_replay_is_deterministic(self):
        events = make_events()
        first = self.run_cli(events)
        second = self.run_cli(events)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(first.stdout, second.stdout)

    def test_cli_missing_id_exits_2(self):
        proc = self.run_cli([{"key": "k", "ts": 1, "val": 1}])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("id", proc.stderr)

    def test_cli_missing_ts_exits_2(self):
        proc = self.run_cli([{"id": "a", "key": "k", "val": 1}])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("ts", proc.stderr)

    def test_cli_negative_ts_marked_bad(self):
        proc = self.run_cli([
            {"id": "a", "key": "k", "ts": -1, "val": "neg"},
            {"id": "b", "key": "k", "ts": 2, "val": "ok"},
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual([json.loads(l)["id"] for l in proc.stdout.splitlines()],
                         ["b"])
        self.assertEqual(json.loads(proc.stderr.strip())["bad"], 1)


if __name__ == "__main__":
    unittest.main()
