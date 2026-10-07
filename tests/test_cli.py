import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SAT3 = {
    "num_tasks": 3,
    "durations": [2, 2, 2],
    "constraints": (
        [{"u": "zero", "v": i, "w": 4} for i in range(3)]
        + [{"u": i, "v": "zero", "w": 0} for i in range(3)]
    ),
    "disjuncts": [[0, 1], [1, 2], [0, 2]],
}

UNSAT_DISJ = {
    "num_tasks": 2,
    "durations": [3, 3],
    "constraints": [
        {"u": "zero", "v": 0, "w": 1},
        {"u": 0, "v": "zero", "w": 0},
        {"u": "zero", "v": 1, "w": 1},
        {"u": 1, "v": "zero", "w": 0},
    ],
    "disjuncts": [[0, 1]],
}


def run_cli(request):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(request, fh)
        path = fh.name
    proc = subprocess.run(
        [sys.executable, "-m", "scheddiag", path],
        cwd=ROOT, capture_output=True, text=True, timeout=60)
    return proc


def run_cli_stdin(raw):
    return subprocess.run(
        [sys.executable, "-m", "scheddiag"],
        cwd=ROOT, input=raw, capture_output=True, text=True, timeout=60)


class TestCliSolve(unittest.TestCase):
    def test_solve_sat(self):
        proc = run_cli({"command": "solve", "instance": SAT3})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "sat")
        self.assertEqual(len(out["schedule"]), 3)

    def test_solve_unsat_and_check(self):
        proc = run_cli({"command": "solve", "instance": UNSAT_DISJ})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "unsat")
        # the emitted evidence must validate through the CLI checker
        proc = run_cli({"command": "check", "instance": UNSAT_DISJ,
                        "evidence": out})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        verdict = json.loads(proc.stdout)
        self.assertTrue(verdict["valid"], verdict["reason"])

    def test_check_rejects_tampered_evidence(self):
        proc = run_cli({"command": "solve", "instance": UNSAT_DISJ})
        out = json.loads(proc.stdout)
        out["certificate"]["tree"]["children"][0]["weight"] = -5
        proc = run_cli({"command": "check", "instance": UNSAT_DISJ,
                        "evidence": out})
        verdict = json.loads(proc.stdout)
        self.assertFalse(verdict["valid"])

    def test_unknown_then_resume_with_frontier(self):
        budget = {"slack": 100000, "branches": 1}
        proc = run_cli({"command": "solve", "instance": SAT3, "budget": budget})
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "unknown")
        self.assertIn("frontier", out)
        # resume from the saved frontier with a full budget
        proc = run_cli({"command": "solve", "instance": SAT3,
                        "frontier": out["frontier"]})
        final = json.loads(proc.stdout)
        self.assertEqual(final["status"], "sat")
        proc = run_cli({"command": "check", "instance": SAT3,
                        "evidence": final})
        self.assertTrue(json.loads(proc.stdout)["valid"])

    def test_stdin_and_error_handling(self):
        proc = run_cli_stdin(json.dumps({"command": "solve", "instance": SAT3}))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], "sat")
        # malformed JSON
        proc = run_cli_stdin("{not json")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout)["status"], "error")
        # invalid instance: non-positive duration
        bad = {"command": "solve",
               "instance": {"num_tasks": 1, "durations": [0]}}
        proc = run_cli_stdin(json.dumps(bad))
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout)["status"], "error")
        # unknown command
        proc = run_cli_stdin(json.dumps({"command": "fly"}))
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
