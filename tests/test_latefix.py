import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from latefix import ADD, RETRACT, Event, run_reference, run_stream

ROOT = Path(__file__).resolve().parent.parent


def recs(events, win, late):
    return [r.to_dict() for r in run_stream(events, win, late)]


class FuzzAgainstReferenceTest(unittest.TestCase):
    """Acceptance 1: n <= 10, streaming output must equal the
    batch-recompute reference ADD/RETRACT sequence."""

    def test_random_small_inputs_match_reference(self):
        rng = random.Random(20261001)
        for trial in range(500):
            n = rng.randint(0, 10)
            win = rng.choice([10, 50, 100])
            late = rng.choice([0, 30, 70])
            events = [
                Event(
                    key=rng.choice(["a", "b", "c"]),
                    ts=rng.randint(0, 400),
                    val=rng.randint(-5, 9),
                )
                for _ in range(n)
            ]
            streamed = run_stream(events, win, late)
            referenced = run_reference(events, win, late)
            self.assertEqual(
                [r.to_dict() for r in streamed],
                [r.to_dict() for r in referenced],
                msg=f"trial={trial} win={win} late={late} events={events}",
            )

    def test_streaming_output_is_well_formed(self):
        rng = random.Random(7)
        for _ in range(200):
            n = rng.randint(0, 10)
            win, late = 50, 40
            events = [
                Event(rng.choice(["x", "y"]), rng.randint(0, 300),
                      rng.randint(0, 5))
                for _ in range(n)
            ]
            out = run_stream(events, win, late)
            last_add = {}
            version = {}
            for rec in out:
                wid = (rec.key, rec.win_start)
                self.assertEqual(rec.win_end, rec.win_start + win)
                if rec.op == ADD:
                    expect = version.get(wid, 0) + 1
                    self.assertEqual(rec.version, expect)
                    version[wid] = expect
                    last_add[wid] = rec.val
                else:
                    self.assertEqual(rec.op, RETRACT)
                    # RETRACT must carry the last ADDed value/version.
                    self.assertEqual(rec.val, last_add[wid])
                    self.assertEqual(rec.version, version[wid])


class BoundaryTest(unittest.TestCase):
    """Acceptance 2: correction at exactly WM == end + late is applied;
    at WM == end + late + 1 the event is dropped."""

    def test_exact_end_plus_late_boundary(self):
        events = [
            Event("a", 10, 5),    # window [0,100), end=100, late=50
            Event("a", 100, 1),   # WM=100 -> ADD(5, v1); own window [100,200)
            Event("a", 150, 9),   # WM=150 == end+late boundary
            Event("a", 20, 7),    # late event, WM=150 <= 150 -> correctable
            Event("a", 151, 1),   # WM=151
            Event("a", 30, 100),  # WM=151 > 150 -> dropped
        ]
        out = recs(events, win=100, late=50)
        self.assertEqual(out, [
            {"key": "a", "win_start": 0, "win_end": 100, "op": "ADD",
             "val": 5, "version": 1},
            {"key": "a", "win_start": 0, "win_end": 100, "op": "RETRACT",
             "val": 5, "version": 1},
            {"key": "a", "win_start": 0, "win_end": 100, "op": "ADD",
             "val": 12, "version": 2},
        ])

    def test_one_past_boundary_dropped(self):
        events = [
            Event("a", 10, 5),
            Event("a", 100, 1),   # WM=100 -> ADD(5, v1)
            Event("a", 151, 1),   # WM=151 > 100+50
            Event("a", 20, 7),    # dropped: WM=151 > end+late=150
        ]
        out = recs(events, win=100, late=50)
        self.assertEqual(out, [
            {"key": "a", "win_start": 0, "win_end": 100, "op": "ADD",
             "val": 5, "version": 1},
        ])


class VersionChainTest(unittest.TestCase):
    """Acceptance 3: two consecutive corrections build a version chain."""

    def test_two_corrections_version_chain(self):
        events = [
            Event("k", 10, 1),
            Event("k", 100, 0),   # WM=100 -> ADD(1, v1)
            Event("k", 20, 2),    # correction -> RETRACT v1, ADD(3, v2)
            Event("k", 30, 3),    # correction -> RETRACT v2, ADD(6, v3)
        ]
        out = recs(events, win=100, late=1000)
        ops = [(r["op"], r["val"], r["version"]) for r in out]
        self.assertEqual(ops, [
            (ADD, 1, 1),
            (RETRACT, 1, 1),
            (ADD, 3, 2),
            (RETRACT, 3, 2),
            (ADD, 6, 3),
        ])

    def test_retract_byte_equal_to_last_add(self):
        events = [
            Event("k", 10, 1),
            Event("k", 100, 0),
            Event("k", 20, 2),
            Event("k", 30, 3),
        ]
        out = recs(events, win=100, late=1000)
        adds = [r for r in out if r["op"] == ADD]
        retracts = [r for r in out if r["op"] == RETRACT]
        self.assertEqual(len(retracts), 2)
        for retract, prior_add in zip(retracts, adds):
            add_bytes = json.dumps(prior_add["val"], sort_keys=True).encode()
            ret_bytes = json.dumps(retract["val"], sort_keys=True).encode()
            self.assertEqual(ret_bytes, add_bytes)


class IdempotencyTest(unittest.TestCase):
    """Acceptance 4: duplicate physical events cause no new versions."""

    def test_duplicate_events_are_idempotent(self):
        events = [
            Event("k", 10, 5),
            Event("k", 10, 5),    # duplicate: ignored
            Event("k", 100, 1),   # WM=100 -> ADD(5, v1), not ADD(10)
            Event("k", 20, 7),    # correction -> v2
            Event("k", 20, 7),    # duplicate: no further version
            Event("k", 20, 7),
        ]
        out = recs(events, win=100, late=1000)
        ops = [(r["op"], r["val"], r["version"]) for r in out]
        self.assertEqual(ops, [
            (ADD, 5, 1),
            (RETRACT, 5, 1),
            (ADD, 12, 2),
        ])

    def test_duplicate_before_emission_counts_once(self):
        events = [Event("k", 10, 5)] * 3 + [Event("k", 100, 0)]
        out = recs(events, win=100, late=0)
        self.assertEqual([r["val"] for r in out], [5])


class EmptyWindowTest(unittest.TestCase):
    def test_empty_windows_never_emit(self):
        events = [Event("k", 10, 5), Event("k", 1000, 1)]
        out = recs(events, win=100, late=0)
        starts = {r["win_start"] for r in out}
        self.assertEqual(starts, {0})  # windows 100..900 stay silent

    def test_empty_input_no_output(self):
        self.assertEqual(recs([], win=100, late=10), [])


class WatermarkTest(unittest.TestCase):
    def test_clock_regression_ignored_not_fatal(self):
        events = [
            Event("k", 500, 1),   # WM=500
            Event("k", 10, 2),    # regression: dropped as too late, no error
            Event("k", 490, 3),   # window [400,500), WM=500 -> emitted
        ]
        out = recs(events, win=100, late=0)
        vals = [(r["win_start"], r["op"], r["val"]) for r in out]
        self.assertIn((400, ADD, 3), vals)
        self.assertNotIn((0, ADD, 2), vals)


class CliTest(unittest.TestCase):
    def _run_cli(self, lines, *extra):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".jsonl", delete=False) as tmp:
            tmp.write("\n".join(lines) + "\n")
            path = tmp.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "latefix", "--in", path,
                 "--win", "100", "--late", "50", *extra],
                capture_output=True, text=True, cwd=ROOT,
            )
        finally:
            Path(path).unlink(missing_ok=True)

    def test_cli_happy_path(self):
        proc = self._run_cli([
            '{"key":"a","ts":10,"val":5}',
            '{"key":"a","ts":100,"val":1}',
            '{"key":"a","ts":20,"val":7}',
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(
            [(r["op"], r["val"], r["version"]) for r in rows],
            [(ADD, 5, 1), (RETRACT, 5, 1), (ADD, 12, 2)],
        )

    def test_cli_non_numeric_val_exits_2(self):
        proc = self._run_cli(['{"key":"a","ts":10,"val":"abc"}'])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("val", proc.stderr)

    def test_cli_boolean_val_exits_2(self):
        proc = self._run_cli(['{"key":"a","ts":10,"val":true}'])
        self.assertEqual(proc.returncode, 2)

    def test_cli_clock_regression_does_not_exit(self):
        proc = self._run_cli([
            '{"key":"a","ts":500,"val":1}',
            '{"key":"a","ts":10,"val":2}',
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)


if __name__ == "__main__":
    unittest.main()
