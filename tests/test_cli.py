import json
import os
import subprocess
import sys
import tempfile
import unittest

from mincostflow import verify

PYTHON = sys.executable
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(args, payload=None):
    env = dict(os.environ, PYTHONPATH=ROOT + os.pathsep
               + os.environ.get("PYTHONPATH", ""))
    if payload is not None:
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as fh:
            json.dump(payload, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [PYTHON, "-m", "mincostflow", *args, path],
                capture_output=True, text=True, cwd=ROOT, env=env)
        finally:
            os.unlink(path)
    else:
        proc = subprocess.run([PYTHON, "-m", "mincostflow", *args],
                              capture_output=True, text=True, cwd=ROOT,
                              env=env)
    return proc


class TestCli(unittest.TestCase):
    def test_solve_reports_independent_statuses(self):
        spec = {
            "demands": {"s": -4, "m": 0, "t": 4},
            "edges": [
                {"id": "fast", "tail": "s", "head": "t", "lower": 0,
                 "upper": 4, "cost": 2},
                {"id": "via1", "tail": "s", "head": "m", "lower": 0,
                 "upper": 4, "cost": 1},
                {"id": "via2", "tail": "m", "head": "t", "lower": 0,
                 "upper": 4, "cost": 1},
            ],
            "batches": [
                {"changes": [{"op": "set_bounds", "edge": "fast",
                              "lower": 0, "upper": 0},
                             {"op": "set_bounds", "edge": "via1",
                              "lower": 0, "upper": 0}]},
                {"changes": [{"op": "set_bounds", "edge": "nope",
                              "lower": 0, "upper": 1}]},
            ],
        }
        proc = run_cli(["solve"], spec)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)

        self.assertEqual(len(out["steps"]), 3)
        first, second, third = out["steps"]
        self.assertTrue(first["feasible"])
        self.assertTrue(first["optimal"])
        self.assertEqual(first["cost"], 8)

        # After cutting the cheap edges the model is infeasible and not
        # optimal: two independent statuses, plus a verifiable certificate.
        self.assertFalse(second["feasible"])
        self.assertFalse(second["optimal"])
        cut_edges = [dict(e, upper=0) if e["id"] in ("fast", "via1") else e
                     for e in spec["edges"]]
        self.assertEqual(verify.check_cut_certificate(
            spec["demands"], cut_edges, second["certificate"]), [])

        # The failed transaction is reported as an error and changed
        # nothing: the published feasible version is still the first one.
        self.assertIn("error", third)
        self.assertIsNone(third["feasible"])
        self.assertIsNone(third["optimal"])
        self.assertEqual(out["published"]["flow"], first["flow"])
        self.assertEqual(out["published"]["cost"], first["cost"])

        # The first step verifies independently against the original model.
        self.assertEqual(verify.check_optimality(
            spec["demands"], spec["edges"],
            first["flow"], first["potentials"]), [])

    def test_verify_subcommand(self):
        spec = {
            "demands": {"s": -2, "t": 2},
            "edges": [{"id": "e", "tail": "s", "head": "t", "lower": 0,
                       "upper": 3, "cost": 4}],
        }
        proc = run_cli(["solve"], spec)
        out = json.loads(proc.stdout)
        doc = {"model": out["model"], "result": out["steps"][0]}

        ok = run_cli(["verify"], doc)
        self.assertEqual(ok.returncode, 0, ok.stdout)
        report = json.loads(ok.stdout)
        self.assertTrue(report["flow_ok"])
        self.assertTrue(report["optimality_ok"])

        tampered = {"model": out["model"],
                    "result": dict(out["steps"][0], flow={"e": 1})}
        bad = run_cli(["verify"], tampered)
        self.assertEqual(bad.returncode, 1)
        self.assertFalse(json.loads(bad.stdout)["flow_ok"])

    def test_budget_limited_solve_is_not_labelled_optimal(self):
        spec = {
            "demands": {"a": 0, "b": 0},
            "edges": [
                {"id": "e1", "tail": "a", "head": "b", "lower": 0,
                 "upper": 5, "cost": -3},
                {"id": "e2", "tail": "b", "head": "a", "lower": 0,
                 "upper": 5, "cost": 1},
            ],
            "budget": 0,
        }
        proc = run_cli(["solve"], spec)
        step = json.loads(proc.stdout)["steps"][0]
        self.assertTrue(step["feasible"])
        self.assertFalse(step["optimal"])
        self.assertIsNone(step["potentials"])


if __name__ == "__main__":
    unittest.main()
