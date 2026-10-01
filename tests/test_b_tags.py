"""Acceptance B: tag mismatch must be INFEASIBLE with non-empty conflict."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

from rostersolve import model, solver


class TestTagAffinity(unittest.TestCase):
    def instance(self):
        return {
            "horizon": 4,
            "jobs": [
                {"id": "j1", "cpu": 1, "mem": 1, "deadline": 4,
                 "duration": 1, "deps": [], "tags": ["gpu"]},
                {"id": "j2", "cpu": 1, "mem": 1, "deadline": 4,
                 "duration": 1, "deps": [], "tags": []},
            ],
            "machines": [
                {"id": "m1", "cpu": 2, "mem": 2, "tags": ["ssd"]},
            ],
        }

    def test_tag_mismatch_infeasible_conflict_nonempty(self):
        jobs, machines, horizon = model.load_instance(self.instance())
        assign, _ = solver.solve(jobs, machines, horizon)
        self.assertIsNone(assign)
        conflict = solver.minimal_conflict(jobs, machines, horizon)
        self.assertEqual(conflict, ["j1"])

    def test_cli_reports_infeasible_with_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.json")
            out = os.path.join(tmp, "plan.json")
            trace = os.path.join(tmp, "trace.json")
            with open(src, "w", encoding="utf-8") as fh:
                json.dump(self.instance(), fh)
            proc = subprocess.run(
                [sys.executable, "-m", "rostersolve", "plan", src,
                 "--out", out, "--trace", trace],
                capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(out, encoding="utf-8") as fh:
                plan = json.load(fh)
            self.assertEqual(plan["status"], "INFEASIBLE")
            self.assertTrue(plan["conflict"])
            self.assertEqual(plan["conflict"], ["j1"])

    def test_matching_tags_feasible(self):
        data = self.instance()
        data["machines"][0]["tags"] = ["gpu", "ssd"]
        jobs, machines, horizon = model.load_instance(data)
        assign, _ = solver.solve(jobs, machines, horizon)
        self.assertIsNotNone(assign)


if __name__ == "__main__":
    unittest.main()
