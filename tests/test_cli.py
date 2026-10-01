"""CLI tests including acceptance test E (deterministic output bytes)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NORMAL_JOBS = [
    {"id": "high", "arrival": 0, "deadline": 5, "work": 3,
     "cost_per_tick": 2, "value": 100},
    {"id": "low", "arrival": 0, "deadline": 5, "work": 2,
     "cost_per_tick": 2, "value": 10},
]


def run_cli(jobs_payload, budget, extra_args=()):
    """Run the CLI in a temp dir; return (exit_code, plan_bytes, stdout, stderr)."""
    with tempfile.TemporaryDirectory() as tmp:
        jobs_path = os.path.join(tmp, "jobs.json")
        out_path = os.path.join(tmp, "plan.json")
        if isinstance(jobs_payload, str):
            jobs_text = jobs_payload
        else:
            jobs_text = json.dumps(jobs_payload)
        with open(jobs_path, "w", encoding="utf-8") as fh:
            fh.write(jobs_text)
        proc = subprocess.run(
            [sys.executable, "-m", "budgetfn", "plan", jobs_path,
             "--budget", str(budget), "--out", out_path, *extra_args],
            cwd=REPO_ROOT, capture_output=True, text=True)
        plan_bytes = None
        if os.path.exists(out_path):
            with open(out_path, "rb") as fh:
                plan_bytes = fh.read()
        return proc.returncode, plan_bytes, proc.stdout, proc.stderr


class CliHappyPath(unittest.TestCase):
    def test_normal_run_exit_zero(self):
        code, plan_bytes, stdout, _ = run_cli(NORMAL_JOBS, 6)
        self.assertEqual(code, 0)
        plan = json.loads(plan_bytes.decode("utf-8"))
        self.assertEqual(plan["spent"], 6)
        self.assertEqual(plan["earned"], 100)
        self.assertEqual(plan["schedule"],
                         ["high", "high", "high", "idle", "idle"])

    def test_zero_budget_outputs_all_idle_not_infeasible(self):
        code, plan_bytes, _, _ = run_cli(NORMAL_JOBS, 0)
        self.assertEqual(code, 0)
        plan = json.loads(plan_bytes.decode("utf-8"))
        self.assertEqual(plan["spent"], 0)
        self.assertEqual(plan["earned"], 0)
        self.assertEqual(plan["schedule"], ["idle"] * 5)

    def test_no_feasible_completion_still_exit_zero(self):
        jobs = [{"id": "a", "arrival": 0, "deadline": 2, "work": 9,
                 "cost_per_tick": 1, "value": 10}]
        code, plan_bytes, _, _ = run_cli(jobs, 100)
        self.assertEqual(code, 0)
        plan = json.loads(plan_bytes.decode("utf-8"))
        self.assertEqual(plan["earned"], 0)
        self.assertEqual(len(plan["schedule"]), 2)


class CliAcceptanceE(unittest.TestCase):
    """Same input planned 5 times yields byte-identical output."""

    def test_deterministic_output_bytes(self):
        outputs = set()
        for _ in range(5):
            code, plan_bytes, _, _ = run_cli(NORMAL_JOBS, 6)
            self.assertEqual(code, 0)
            outputs.add(plan_bytes)
        self.assertEqual(len(outputs), 1)


class CliErrors(unittest.TestCase):
    def test_deadline_not_after_arrival_exit_2(self):
        jobs = [{"id": "x", "arrival": 2, "deadline": 2, "work": 1,
                 "cost_per_tick": 1, "value": 1}]
        code, plan_bytes, _, stderr = run_cli(jobs, 10)
        self.assertEqual(code, 2)
        self.assertIsNone(plan_bytes)
        self.assertIn("deadline", stderr)

    def test_negative_budget_exit_2(self):
        code, plan_bytes, _, stderr = run_cli(NORMAL_JOBS, -1)
        self.assertEqual(code, 2)
        self.assertIsNone(plan_bytes)
        self.assertIn("budget", stderr)

    def test_negative_cost_exit_2(self):
        jobs = [{"id": "x", "arrival": 0, "deadline": 2, "work": 1,
                 "cost_per_tick": -3, "value": 1}]
        code, plan_bytes, _, stderr = run_cli(jobs, 10)
        self.assertEqual(code, 2)
        self.assertIsNone(plan_bytes)
        self.assertIn("cost_per_tick", stderr)

    def test_missing_jobs_file_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(
                [sys.executable, "-m", "budgetfn", "plan",
                 os.path.join(tmp, "nope.json"),
                 "--budget", "5", "--out", os.path.join(tmp, "p.json")],
                cwd=REPO_ROOT, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 2)

    def test_malformed_json_exit_2(self):
        code, _, _, _ = run_cli("{not json", 5)
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
