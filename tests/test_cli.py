import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_cli(jobs_path, budget, out_path):
    return subprocess.run(
        [sys.executable, "-m", "budgetfn", "plan", str(jobs_path),
         "--budget", str(budget), "--out", str(out_path)],
        cwd=ROOT, capture_output=True, text=True,
    )


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.jobs_path = self.dir / "jobs.json"
        self.out_path = self.dir / "plan.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write_jobs(self, jobs):
        self.jobs_path.write_text(json.dumps(jobs), encoding="utf-8")

    def test_normal_run_exit_zero(self):
        self.write_jobs([
            {"id": "a", "arrival": 0, "deadline": 2, "work": 1,
             "cost_per_tick": 3, "value": 10},
            {"id": "b", "arrival": 0, "deadline": 2, "work": 1,
             "cost_per_tick": 1, "value": 4},
        ])
        result = run_cli(self.jobs_path, 4, self.out_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(self.out_path.read_text(encoding="utf-8"))
        self.assertEqual(plan["earned"], 14)
        self.assertEqual(plan["spent"], 4)
        self.assertEqual([t["job"] for t in plan["ticks"]], ["a", "b"])

    def test_zero_budget_outputs_legal_idle_plan(self):
        self.write_jobs([
            {"id": "a", "arrival": 0, "deadline": 3, "work": 2,
             "cost_per_tick": 1, "value": 10},
        ])
        result = run_cli(self.jobs_path, 0, self.out_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(self.out_path.read_text(encoding="utf-8"))
        self.assertEqual(plan["spent"], 0)
        self.assertEqual(plan["earned"], 0)
        self.assertEqual([t["job"] for t in plan["ticks"]], ["idle"] * 3)

    def test_error_exit_code_2(self):
        bad_cases = [
            ([{"id": "x", "arrival": 2, "deadline": 2, "work": 1,
               "cost_per_tick": 1, "value": 1}], 5),   # deadline <= arrival
            ([{"id": "x", "arrival": 0, "deadline": 1, "work": 1,
               "cost_per_tick": -1, "value": 1}], 5),  # negative cost
            ([], -3),                                   # negative budget
        ]
        for jobs, budget in bad_cases:
            with self.subTest(jobs=jobs, budget=budget):
                self.write_jobs(jobs)
                result = run_cli(self.jobs_path, budget, self.out_path)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.out_path.exists())

    def test_missing_jobs_file_exit_code_2(self):
        result = run_cli(self.dir / "nope.json", 1, self.out_path)
        self.assertEqual(result.returncode, 2)

    def test_e_five_runs_byte_identical(self):
        self.write_jobs([
            {"id": f"job{i}", "arrival": i % 2, "deadline": 4 + i,
             "work": 2, "cost_per_tick": 1 + (i % 3), "value": 5 * i + 2}
            for i in range(6)
        ])
        digests = set()
        for run in range(5):
            out = self.dir / f"plan{run}.json"
            result = run_cli(self.jobs_path, 11, out)
            self.assertEqual(result.returncode, 0, result.stderr)
            digests.add(hashlib.sha256(out.read_bytes()).hexdigest())
        self.assertEqual(len(digests), 1)


if __name__ == "__main__":
    unittest.main()
