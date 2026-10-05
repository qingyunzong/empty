import json
import math
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from latefix import Engine, MalformedRecordError, run


def reference_run(events, win, late):
    """Batch-recompute reference: at every emission point the window value is
    recomputed from scratch as the sum of all accepted events (deduped,
    non-dropped) for that window, in arrival order."""
    seen = set()
    wm = None
    accepted = {}   # (key, start) -> list of vals in arrival order
    emitted = {}    # (key, start) -> version
    out = []

    def bounds(ts):
        start = math.floor(ts / win) * win
        return start, start + win

    def rec(op, key, start, end, val, version):
        return {"key": key, "start": start, "end": end,
                "op": op, "val": val, "version": version}

    for e in events:
        key, ts, val = e["key"], e["ts"], e["val"]
        marker = json.dumps([key, ts, val], sort_keys=True, separators=(",", ":"))
        if marker in seen:
            continue
        seen.add(marker)
        wm = ts if wm is None else max(wm, ts)
        start, end = bounds(ts)
        wkey = (key, start)

        if wkey in emitted:
            if wm <= end + late:
                old = sum(accepted[wkey])
                out.append(rec("RETRACT", key, start, end, old, emitted[wkey]))
                accepted[wkey].append(val)
                emitted[wkey] += 1
                out.append(rec("ADD", key, start, end, sum(accepted[wkey]), emitted[wkey]))
            continue
        if wkey not in accepted:
            if wm > end + late:
                continue
            accepted[wkey] = []
        accepted[wkey].append(val)

        # finalize all windows with end <= wm, deterministic order
        ready = [(k, s) for (k, s) in accepted
                 if (k, s) not in emitted and s + win <= wm]
        for k, s in sorted(ready, key=lambda ks: (ks[1] + win, str(ks[0]), ks[1])):
            emitted[(k, s)] = 1
            out.append(rec("ADD", k, s, s + win, sum(accepted[(k, s)]), 1))
    return out


def ops(stream):
    return [(r["op"], r["key"], r["start"], r["val"], r["version"]) for r in stream]


class TestReferenceFuzz(unittest.TestCase):
    """Acceptance 1: n<=10 streaming output matches batch-recompute reference."""

    def test_random_small_inputs(self):
        rng = random.Random(20261005)
        for trial in range(600):
            win = rng.choice([10, 100, 30000])
            late = rng.choice([0, 5, 50, 10000])
            n = rng.randint(0, 10)
            keys = ["a", "b", "c"]
            events = []
            for _ in range(n):
                events.append({
                    "key": rng.choice(keys),
                    "ts": rng.randint(0, 3 * win + 2 * late),
                    "val": rng.choice([0, 1, -1, 2, 7, 100, 1.5, -2.5]),
                })
                # sometimes duplicate the previous physical event
                if events and rng.random() < 0.2:
                    events.append(dict(events[-1]))
            got = run(events, win, late)
            want = reference_run(events, win, late)
            self.assertEqual(ops(want), ops(got),
                             f"trial={trial} win={win} late={late} events={events}")
            for r_want, r_got in zip(want, got):
                self.assertEqual(json.dumps(r_want, sort_keys=True),
                                 json.dumps(r_got, sort_keys=True))


class TestLatenessBoundary(unittest.TestCase):
    """Acceptance 2: correction allowed at exactly end+late, dropped at +1."""

    WIN, LATE = 30000, 10000  # window [0,30000): horizon = 40000

    def test_exact_boundary_corrects(self):
        events = [
            {"key": "k", "ts": 10000, "val": 1},
            {"key": "k", "ts": 30000, "val": 0},   # WM=30000 -> finalize [0,30000) ADD 1 v1
            {"key": "k", "ts": 40000, "val": 9},   # WM=40000 (other window)
            {"key": "k", "ts": 5000, "val": 2},    # WM == end+late == 40000 -> allowed
        ]
        out = run(events, self.WIN, self.LATE)
        w0 = [r for r in out if r["start"] == 0]
        self.assertEqual(ops(w0), [
            ("ADD", "k", 0, 1, 1),
            ("RETRACT", "k", 0, 1, 1),
            ("ADD", "k", 0, 3, 2),
        ])

    def test_one_past_boundary_dropped(self):
        events = [
            {"key": "k", "ts": 10000, "val": 1},
            {"key": "k", "ts": 30000, "val": 0},   # finalize [0,30000)
            {"key": "k", "ts": 40001, "val": 9},   # WM=40001 > end+late
            {"key": "k", "ts": 5000, "val": 2},    # dropped
        ]
        out = run(events, self.WIN, self.LATE)
        w0 = [r for r in out if r["start"] == 0]
        self.assertEqual(ops(w0), [("ADD", "k", 0, 1, 1)])

    def test_first_event_beyond_horizon_dropped(self):
        events = [
            {"key": "k", "ts": 50000, "val": 1},   # WM=50000
            {"key": "k", "ts": 5000, "val": 2},    # window [0,30000), 50000 > 40000 -> drop
        ]
        out = run(events, self.WIN, self.LATE)
        self.assertEqual([r for r in out if r["start"] == 0], [])


class TestVersionChain(unittest.TestCase):
    """Acceptance 3: two consecutive corrections produce a 1->2->3 version chain."""

    def test_two_corrections(self):
        events = [
            {"key": "k", "ts": 1000, "val": 10},
            {"key": "k", "ts": 2000, "val": 20},
            {"key": "k", "ts": 30000, "val": 0},   # finalize: ADD 30 v1
            {"key": "k", "ts": 1500, "val": 5},    # correction -> v2, total 35
            {"key": "k", "ts": 2500, "val": -3},   # correction -> v3, total 32
        ]
        out = run(events, 30000, 10000)
        self.assertEqual(ops(out), [
            ("ADD", "k", 0, 30, 1),
            ("RETRACT", "k", 0, 30, 1),
            ("ADD", "k", 0, 35, 2),
            ("RETRACT", "k", 0, 35, 2),
            ("ADD", "k", 0, 32, 3),
        ])
        # RETRACT payload must be byte-identical to the previous ADD payload
        adds = [json.dumps(r, sort_keys=True) for r in out if r["op"] == "ADD"]
        retracts = [r for r in out if r["op"] == "RETRACT"]
        for ret, prev_add in zip(retracts, adds):
            prev = json.loads(prev_add)
            self.assertEqual(json.dumps({**prev, "op": "RETRACT"}, sort_keys=True),
                             json.dumps(ret, sort_keys=True))


class TestIdempotency(unittest.TestCase):
    """Acceptance 4: duplicate physical events never trigger versions."""

    def test_duplicate_before_and_after_finalize(self):
        events = [
            {"key": "k", "ts": 1000, "val": 10},
            {"key": "k", "ts": 1000, "val": 10},   # dup: counted once
            {"key": "k", "ts": 30000, "val": 0},   # finalize: ADD 10 v1
            {"key": "k", "ts": 1000, "val": 10},   # dup after finalize: no correction
            {"key": "k", "ts": 1000, "val": 10},   # dup again
        ]
        out = run(events, 30000, 10000)
        self.assertEqual(ops(out), [("ADD", "k", 0, 10, 1)])

    def test_same_ts_different_val_not_duplicate(self):
        events = [
            {"key": "k", "ts": 1000, "val": 10},
            {"key": "k", "ts": 1000, "val": 11},   # distinct physical event
            {"key": "k", "ts": 30000, "val": 0},
        ]
        out = run(events, 30000, 10000)
        self.assertEqual(ops(out), [("ADD", "k", 0, 21, 1)])


class TestWatermarkAndEmpty(unittest.TestCase):
    def test_empty_windows_never_emit(self):
        events = [{"key": "k", "ts": 1000, "val": 1},
                  {"key": "k", "ts": 89000, "val": 2},
                  {"key": "k", "ts": 120000, "val": 3}]
        out = run(events, 30000, 10000)
        starts = sorted({r["start"] for r in out})
        self.assertEqual(starts, [0, 60000])  # [30000,60000) empty -> absent

    def test_wm_never_regresses(self):
        # a small-ts event after a large-ts event must not reopen dropped windows
        events = [
            {"key": "k", "ts": 100000, "val": 1},  # WM=100000
            {"key": "k", "ts": 1000, "val": 5},    # [0,30000): 100000 > 40000 -> drop
        ]
        out = run(events, 30000, 10000)
        self.assertEqual([r for r in out if r["start"] == 0], [])

    def test_multiple_keys_independent(self):
        events = [
            {"key": "a", "ts": 1000, "val": 1},
            {"key": "b", "ts": 2000, "val": 2},
            {"key": "x", "ts": 30000, "val": 0},
        ]
        out = run(events, 30000, 10000)
        self.assertEqual(ops(out), [
            ("ADD", "a", 0, 1, 1),
            ("ADD", "b", 0, 2, 1),
        ])


class TestValidation(unittest.TestCase):
    def test_non_numeric_val_rejected(self):
        eng = Engine(30000, 10000)
        for bad in ["1", "abc", None, True, [1], {"x": 1}]:
            with self.assertRaises(MalformedRecordError, msg=f"val={bad!r}"):
                eng.process({"key": "k", "ts": 1, "val": bad})

    def test_missing_fields_rejected(self):
        eng = Engine(30000, 10000)
        with self.assertRaises(MalformedRecordError):
            eng.process({"key": "k", "ts": 1})

    def test_clock_regression_ignored_not_error(self):
        eng = Engine(30000, 10000)
        eng.process({"key": "k", "ts": 50000, "val": 1})
        out = eng.process({"key": "k", "ts": 10, "val": 2})  # no exception, no emit
        self.assertEqual(out, [])


class TestCli(unittest.TestCase):
    def _run_cli(self, lines, *extra):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            for line in lines:
                f.write(line if isinstance(line, str) else json.dumps(line))
                f.write("\n")
            path = f.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "latefix", "--in", path,
                 "--win", "30000", "--late", "10000", *extra],
                capture_output=True, text=True,
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        finally:
            os.unlink(path)

    def test_cli_happy_path(self):
        proc = self._run_cli([
            {"key": "k", "ts": 1000, "val": 10},
            {"key": "k", "ts": 30000, "val": 0},
            {"key": "k", "ts": 1500, "val": 5},
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = [json.loads(l) for l in proc.stdout.strip().splitlines()]
        self.assertEqual(ops(rows), [
            ("ADD", "k", 0, 10, 1),
            ("RETRACT", "k", 0, 10, 1),
            ("ADD", "k", 0, 15, 2),
        ])

    def test_cli_non_numeric_val_exit2(self):
        proc = self._run_cli([{"key": "k", "ts": 1, "val": "abc"}])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("val", proc.stderr)

    def test_cli_bad_json_exit2(self):
        proc = self._run_cli(["not json{"])
        self.assertEqual(proc.returncode, 2)

    def test_cli_missing_file_exit2(self):
        proc = subprocess.run(
            [sys.executable, "-m", "latefix", "--in", "/nonexistent/e.jsonl",
             "--win", "30000", "--late", "10000"],
            capture_output=True, text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
