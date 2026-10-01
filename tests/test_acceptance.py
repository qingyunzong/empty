"""Acceptance tests A, B, C and E."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gpupack.model import parse_problem
from gpupack.scheduler import solve

ROOT = Path(__file__).resolve().parent.parent


def solve_spec(spec):
    return solve(parse_problem(spec))


def by_id(solution):
    return {j["id"]: j for j in solution.jobs}


class TestAShareableBinPacking(unittest.TestCase):
    """A: two small shareable jobs are packed onto the same GPU."""

    def test_packing(self):
        spec = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                {"id": "j1", "mem": 5, "sm": 5, "shareable": True,
                 "preemptible": False, "arrival": 0, "duration": 2},
                {"id": "j2", "mem": 5, "sm": 5, "shareable": True,
                 "preemptible": False, "arrival": 0, "duration": 3},
            ],
        }
        sol = solve_spec(spec)
        jobs = by_id(sol)
        # One start per GPU per tick: j1 starts at 0, j2 packs in at tick 1.
        self.assertEqual(
            jobs["j1"],
            {"id": "j1", "start": 0, "end": 2, "gpu": "g0", "preemptions": 0},
        )
        self.assertEqual(
            jobs["j2"],
            {"id": "j2", "start": 1, "end": 4, "gpu": "g0", "preemptions": 0},
        )
        self.assertEqual(sol.objective, 6)
        # Both co-located on the same card: 5+5 <= 10 for mem and sm.
        self.assertEqual(jobs["j1"]["gpu"], jobs["j2"]["gpu"])


class TestBPreemptionRestart(unittest.TestCase):
    """B: a higher-priority arrival evicts a lower-priority job, which pays
    a 1-tick restart when rescheduled."""

    def test_preemption_and_restart_tick(self):
        spec = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                {"id": "low", "mem": 10, "sm": 4, "shareable": False,
                 "preemptible": True, "arrival": 0, "duration": 10},
                {"id": "high", "mem": 10, "sm": 4, "shareable": False,
                 "preemptible": False, "arrival": 3, "duration": 2},
            ],
        }
        sol = solve_spec(spec)
        jobs = by_id(sol)
        # high arrives at t=3 (later arrival => higher priority), evicts low,
        # runs [3,5). low keeps its remaining 7 ticks, restarts at t=5,
        # pays 1 restart tick, completes at 5 + 1 + 7 = 13.
        self.assertEqual(
            jobs["high"],
            {"id": "high", "start": 3, "end": 5, "gpu": "g0", "preemptions": 0},
        )
        self.assertEqual(
            jobs["low"],
            {"id": "low", "start": 0, "end": 13, "gpu": "g0", "preemptions": 1},
        )
        self.assertEqual(sol.objective, 18)


class TestCConflictOrdering(unittest.TestCase):
    """C: a non-shareable big job blocks co-location with a shareable job;
    the objective decides the order."""

    def test_ordering(self):
        spec = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                {"id": "big", "mem": 10, "sm": 10, "shareable": False,
                 "preemptible": False, "arrival": 0, "duration": 4},
                {"id": "small", "mem": 4, "sm": 4, "shareable": True,
                 "preemptible": False, "arrival": 0, "duration": 2},
            ],
        }
        sol = solve_spec(spec)
        jobs = by_id(sol)
        # small first (sum 2+6=8) beats big first (sum 4+6=10).
        self.assertEqual(
            jobs["small"],
            {"id": "small", "start": 0, "end": 2, "gpu": "g0", "preemptions": 0},
        )
        self.assertEqual(
            jobs["big"],
            {"id": "big", "start": 2, "end": 6, "gpu": "g0", "preemptions": 0},
        )
        self.assertEqual(sol.objective, 8)


class TestEDeterminism(unittest.TestCase):
    """E: repeated CLI runs produce byte-identical output."""

    def run_cli(self, out_path):
        return subprocess.run(
            [sys.executable, "-m", "gpupack", "schedule",
             str(ROOT / "examples" / "req.json"), "--out", str(out_path)],
            cwd=ROOT, capture_output=True, text=True,
        )

    def test_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            out1 = Path(tmp) / "a.json"
            out2 = Path(tmp) / "b.json"
            r1 = self.run_cli(out1)
            r2 = self.run_cli(out2)
            self.assertEqual(r1.returncode, 0, r1.stderr)
            self.assertEqual(r2.returncode, 0, r2.stderr)
            b1 = out1.read_bytes()
            b2 = out2.read_bytes()
            self.assertEqual(b1, b2)
            self.assertEqual(
                hashlib.sha256(b1).hexdigest(), hashlib.sha256(b2).hexdigest()
            )
            # Output is valid JSON with the expected schema.
            doc = json.loads(b1.decode())
            for job in doc["jobs"]:
                self.assertEqual(
                    set(job), {"id", "start", "end", "gpu", "preemptions"}
                )


if __name__ == "__main__":
    unittest.main()
