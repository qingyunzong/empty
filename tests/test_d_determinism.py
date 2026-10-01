"""Acceptance D: identical input -> byte-identical trace across 5 runs."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(src, out, trace):
    return subprocess.run(
        [sys.executable, "-m", "rostersolve", "plan", src,
         "--out", out, "--trace", trace],
        capture_output=True, text=True, cwd=REPO_ROOT)


class TestDeterminism(unittest.TestCase):
    INSTANCE = {
        "horizon": 10,
        "jobs": [
            {"id": "j1", "cpu": 2, "mem": 1, "deadline": 8,
             "duration": 2, "deps": [], "tags": ["x"]},
            {"id": "j2", "cpu": 1, "mem": 2, "deadline": 10,
             "duration": 3, "deps": ["j1"], "tags": []},
            {"id": "j3", "cpu": 3, "mem": 1, "deadline": 6,
             "duration": 2, "deps": [], "tags": ["y"]},
            {"id": "j4", "cpu": 1, "mem": 1, "deadline": 10,
             "duration": 1, "deps": ["j2", "j3"], "tags": []},
        ],
        "machines": [
            {"id": "m1", "cpu": 4, "mem": 3, "tags": ["x", "y"]},
            {"id": "m2", "cpu": 2, "mem": 2, "tags": ["x"]},
        ],
    }

    def test_five_runs_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.json")
            with open(src, "w", encoding="utf-8") as fh:
                json.dump(self.INSTANCE, fh)
            outs, traces = [], []
            for i in range(5):
                out = os.path.join(tmp, f"plan{i}.json")
                trace = os.path.join(tmp, f"trace{i}.json")
                proc = run_cli(src, out, trace)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                with open(out, "rb") as fh:
                    outs.append(fh.read())
                with open(trace, "rb") as fh:
                    traces.append(fh.read())
            for i in range(1, 5):
                self.assertEqual(outs[0], outs[i])
                self.assertEqual(traces[0], traces[i])

    def test_example_a_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "a.json")
            trace = os.path.join(tmp, "t.json")
            proc = run_cli(os.path.join(REPO_ROOT, "examples", "a.json"),
                           out, trace)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(out, encoding="utf-8") as fh:
                plan = json.load(fh)
            self.assertEqual(plan["status"], "FEASIBLE")
            self.assertEqual(plan["makespan"], 4)
            self.assertEqual(len(plan["schedule"]["m1"]), 6)


if __name__ == "__main__":
    unittest.main()
