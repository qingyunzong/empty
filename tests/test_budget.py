import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from exactcount import Problem, Solver
from exactcount.reference import brute_force_count

REPO_ROOT = Path(__file__).resolve().parent.parent

PDICT = {
    "variables": {"a": [0, 1, 2], "b": [0, 1, 2], "c": [0, 1, 2]},
    "constraints": [
        {"scope": ["a", "b"], "tuples": [[0, 0], [1, 1], [2, 2]]},
        {"scope": ["b", "c"], "tuples": [[0, 1], [1, 2], [2, 0]]},
    ],
}
EXACT = 3  # a=b, c=b+1 mod 3


def fresh_solver():
    return Solver(Problem.from_dict(PDICT))


class BudgetEdgeTest(unittest.TestCase):
    def test_budget_zero_pauses_immediately(self):
        solver = fresh_solver()
        result = solver.solve(0)
        self.assertFalse(result["complete"])
        self.assertEqual(result["confirmed_lower"], 0)
        self.assertEqual(result["certified_upper"], 27)
        self.assertIsNone(result["exact"])
        # Checkpoint is resumable and finishes with the exact count.
        restored = Solver.from_checkpoint(
            json.loads(json.dumps(solver.checkpoint()))
        )
        final = restored.solve()
        self.assertEqual(final["exact"], EXACT)

    def test_exact_budget_completes_one_less_does_not(self):
        reference = fresh_solver().solve()
        needed = reference["checks_total"]
        self.assertGreater(needed, 0)

        exact_fit = fresh_solver().solve(needed)
        self.assertTrue(exact_fit["complete"])
        self.assertEqual(exact_fit["exact"], EXACT)
        self.assertEqual(exact_fit["checks_total"], needed)

        one_less = fresh_solver().solve(needed - 1)
        self.assertFalse(one_less["complete"])
        self.assertIsNone(one_less["exact"])

    def test_repeated_single_unit_budget_resume(self):
        needed = fresh_solver().solve()["checks_total"]
        solver = fresh_solver()
        rounds = 0
        while True:
            result = solver.solve(1)
            rounds += 1
            # Resume in a "new process": full JSON round trip.
            solver = Solver.from_checkpoint(
                json.loads(json.dumps(solver.checkpoint()))
            )
            self.assertLessEqual(result["confirmed_lower"], EXACT)
            self.assertLessEqual(EXACT, result["certified_upper"])
            if result["complete"]:
                break
            self.assertLess(rounds, needed + 1)
        self.assertEqual(rounds, needed)
        self.assertEqual(result["exact"], EXACT)
        self.assertEqual(solver.checks_total, needed)

    def test_negative_budget_rejected(self):
        with self.assertRaises(ValueError):
            fresh_solver().solve(-1)


class CliResumeTest(unittest.TestCase):
    """Pause and resume across real processes via the JSON CLI."""

    def _run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "exactcount", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_cross_process_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            problem = Path(tmp) / "problem.json"
            cp1 = Path(tmp) / "cp1.json"
            cp2 = Path(tmp) / "cp2.json"
            cert = Path(tmp) / "cert.json"
            problem.write_text(json.dumps(PDICT))

            first = self._run_cli(
                "solve", str(problem), "--budget", "1",
                "--checkpoint-out", str(cp1),
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            out1 = json.loads(first.stdout)
            self.assertFalse(out1["complete"])
            self.assertIsNone(out1["exact"])
            self.assertTrue(cp1.exists())

            second = self._run_cli(
                "solve", str(problem),
                "--checkpoint-in", str(cp1),
                "--budget", "100000",
                "--checkpoint-out", str(cp2),
                "--certificate-out", str(cert),
            )
            self.assertEqual(second.returncode, 0, second.stderr)
            out2 = json.loads(second.stdout)
            self.assertTrue(out2["complete"])
            self.assertEqual(out2["exact"], brute_force_count(PDICT))

            verify = self._run_cli("verify", str(cert))
            self.assertEqual(verify.returncode, 0, verify.stderr)
            self.assertTrue(json.loads(verify.stdout)["valid"])

    def test_cli_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            problem = Path(tmp) / "problem.json"
            problem.write_text(json.dumps(PDICT))
            proc = self._run_cli("count", str(problem))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)["exact"], EXACT)


if __name__ == "__main__":
    unittest.main()
