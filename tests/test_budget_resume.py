"""Pause/resume: one-unit budgets, checkpoints, and new-process resume."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

from schcount import Constraint, Problem, Solver

from helpers import brute_force

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sample_problem():
    p = Problem()
    for v in ("x", "y", "z"):
        p.add_variable(v, [0, 1, 2])
    p.add_constraint(Constraint("c1", ("x", "y"), [(0, 1), (1, 2), (2, 0)]))
    p.add_constraint(Constraint("c2", ("y", "z"), [(0, 0), (1, 1), (2, 2)]))
    return p


class TestOneUnitResume(unittest.TestCase):
    def test_repeated_one_unit_budget_in_process(self):
        p = sample_problem()
        exact = brute_force(p)
        solver = Solver(p)
        pauses = 0
        while True:
            result = solver.solve(budget=1)
            self.assertLessEqual(result["confirmed_lower"], exact)
            self.assertLessEqual(exact, result["certified_upper"])
            solver = Solver.from_checkpoint(solver.to_checkpoint())
            if result["complete"]:
                break
            pauses += 1
            self.assertLess(pauses, 100000)
        self.assertEqual(result["exact"], exact)
        self.assertGreater(pauses, 0)

    def test_resume_in_new_process_via_cli(self):
        p = sample_problem()
        exact = brute_force(p)
        env = dict(os.environ)
        env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        with tempfile.TemporaryDirectory() as tmp:
            problem_path = os.path.join(tmp, "problem.json")
            checkpoint_path = os.path.join(tmp, "checkpoint.json")
            result_path = os.path.join(tmp, "result.json")
            with open(problem_path, "w", encoding="utf-8") as fh:
                json.dump(p.to_json(), fh)

            def run(args):
                proc = subprocess.run(
                    [sys.executable, "-m", "schcount"] + args,
                    capture_output=True,
                    text=True,
                    cwd=REPO_ROOT,
                    env=env,
                    timeout=120,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
                with open(result_path, "r", encoding="utf-8") as fh:
                    return json.load(fh)

            result = run(
                [
                    "solve",
                    problem_path,
                    "--budget",
                    "1",
                    "--checkpoint",
                    checkpoint_path,
                    "--result",
                    result_path,
                ]
            )
            rounds = 0
            while not result["complete"]:
                self.assertLessEqual(result["confirmed_lower"], exact)
                self.assertLessEqual(exact, result["certified_upper"])
                self.assertIsNone(result["exact"])
                result = run(
                    [
                        "resume",
                        checkpoint_path,
                        "--budget",
                        "1",
                        "--checkpoint",
                        checkpoint_path,
                        "--result",
                        result_path,
                    ]
                )
                rounds += 1
                self.assertLess(rounds, 100000)
            self.assertEqual(result["exact"], exact)

    def test_checkpoint_file_roundtrip(self):
        p = sample_problem()
        solver = Solver(p)
        solver.solve(budget=3)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cp.json")
            solver.save_checkpoint(path)
            restored = Solver.load_checkpoint(path)
        result = restored.solve()
        self.assertEqual(result["exact"], brute_force(p))

    def test_zero_budget_then_resume(self):
        p = sample_problem()
        solver = Solver(p)
        first = solver.solve(budget=0)
        self.assertFalse(first["complete"])
        self.assertEqual(first["support_checks"], 0)
        solver = Solver.from_checkpoint(solver.to_checkpoint())
        final = solver.solve()
        self.assertEqual(final["exact"], brute_force(p))


if __name__ == "__main__":
    unittest.main()
