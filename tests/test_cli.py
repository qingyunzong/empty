import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(cwd, *args):
    return subprocess.run(
        [sys.executable, "-m", "executor", *args],
        cwd=cwd,
        env={**os.environ, "PYTHONPATH": ROOT},
        capture_output=True,
        text=True,
    )


GOOD_PLAN = {
    "budget": 100,
    "root": {
        "id": "root",
        "cost": 1,
        "compensation_cost": 1,
        "children": [
            {"id": "a", "cost": 2, "compensation_cost": 2},
            {"id": "b", "cost": 3, "outcome": "fail"},
        ],
    },
}


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.plan_path = os.path.join(self.tmp.name, "plan.json")
        with open(self.plan_path, "w", encoding="utf-8") as handle:
            json.dump(GOOD_PLAN, handle)

    def test_load_run_status_flow(self):
        proc = run_cli(self.tmp.name, "load", self.plan_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        loaded = json.loads(proc.stdout)
        self.assertTrue(loaded["loaded"])
        self.assertEqual(loaded["actions"], 3)

        proc = run_cli(self.tmp.name, "status")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], "loaded")

        proc = run_cli(self.tmp.name, "run")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["state"], "ROLLED_BACK")
        self.assertEqual(result["compensations"], ["a", "root"])

        proc = run_cli(self.tmp.name, "status")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        status = json.loads(proc.stdout)
        self.assertEqual(status["status"], "finished")
        self.assertEqual(status["result"]["state"], "ROLLED_BACK")

    def test_exit_code_7_on_invalid_plan(self):
        bad = os.path.join(self.tmp.name, "bad.json")
        with open(bad, "w", encoding="utf-8") as handle:
            json.dump({"budget": 1001, "root": {"id": "x"}}, handle)
        proc = run_cli(self.tmp.name, "load", bad)
        self.assertEqual(proc.returncode, 7)
        self.assertIn("error:", proc.stderr)

    def test_exit_code_7_on_malformed_json(self):
        bad = os.path.join(self.tmp.name, "broken.json")
        with open(bad, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        proc = run_cli(self.tmp.name, "load", bad)
        self.assertEqual(proc.returncode, 7)

    def test_exit_code_7_on_run_without_load(self):
        proc = run_cli(self.tmp.name, "run")
        self.assertEqual(proc.returncode, 7)

    def test_exit_code_7_on_status_without_state(self):
        proc = run_cli(self.tmp.name, "status")
        self.assertEqual(proc.returncode, 7)

    def test_exit_code_7_on_unknown_command(self):
        proc = run_cli(self.tmp.name, "frobnicate")
        self.assertEqual(proc.returncode, 7)

    def test_exit_code_7_on_missing_plan_file(self):
        proc = run_cli(self.tmp.name, "load", "/nonexistent/plan.json")
        self.assertEqual(proc.returncode, 7)

    def test_budget_exhausted_via_cli(self):
        plan = {
            "budget": 16,
            "root": {
                "id": "r", "cost": 0, "compensation_cost": 5,
                "children": [
                    {"id": "k", "cost": 5, "compensation_cost": 6},
                    {"id": "f", "cost": 5, "outcome": "fail"},
                ],
            },
        }
        path = os.path.join(self.tmp.name, "p2.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(plan, handle)
        self.assertEqual(run_cli(self.tmp.name, "load", path).returncode, 0)
        proc = run_cli(self.tmp.name, "run")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["state"], "BUDGET_EXHAUSTED")
        self.assertEqual(result["compensations"], ["k"])
        self.assertEqual(result["budget_remaining"], 0)


if __name__ == "__main__":
    unittest.main()
