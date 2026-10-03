import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NETWORK = {
    "nodes": ["s", "a", "t"],
    "edges": [
        {"id": "e1", "tail": "s", "head": "a", "lower": 0, "upper": 4, "cost": 1},
        {"id": "e2", "tail": "a", "head": "t", "lower": 0, "upper": 4, "cost": 1},
        {"id": "e3", "tail": "s", "head": "t", "lower": 0, "upper": 4, "cost": 5},
    ],
    "demands": {"s": -3, "a": 0, "t": 3},
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "mcflow", *args],
        cwd=REPO_ROOT, capture_output=True, text=True)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, payload):
        path = os.path.join(self.tmp.name, "input.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        return path

    def test_verify_valid_certificate(self):
        path = self.write({
            "network": NETWORK,
            "certificate": {
                "flows": {"e1": 3, "e2": 3, "e3": 0},
                "potentials": {"s": -2, "a": -1, "t": 0},
                "declared_cost": 6,
            },
        })
        proc = run_cli("verify", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertTrue(report["ok"])

    def test_verify_invalid_certificate(self):
        path = self.write({
            "network": NETWORK,
            "certificate": {
                "flows": {"e1": 0, "e2": 0, "e3": 3},
                "potentials": {"s": 0, "a": 0, "t": 0},
                "declared_cost": 14,
            },
        })
        proc = run_cli("verify", path)
        self.assertEqual(proc.returncode, 1)
        report = json.loads(proc.stdout)
        self.assertFalse(report["ok"])
        types = {v["type"] for v in report["violations"]}
        self.assertIn("cost_mismatch", types)
        self.assertIn("negative_cycle", types)

    def test_repair_optimal(self):
        path = self.write({
            "network": NETWORK,
            "flow": {"e1": 3, "e2": 2, "e3": 0},
        })
        proc = run_cli("repair", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "optimal")
        self.assertTrue(result["optimal"])
        self.assertEqual(result["changed_edges"], 1)
        self.assertEqual(result["flow"], {"e1": 3, "e2": 3, "e3": 0})

    def test_repair_with_budget_and_infeasible(self):
        path = self.write({
            "network": NETWORK,
            "flow": {"e1": 3, "e2": 2, "e3": 0},
            "budget": 1,
        })
        proc = run_cli("repair", path)
        self.assertEqual(proc.returncode, 1)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertFalse(result["optimal"])
        self.assertGreaterEqual(result["lower_bound_changes"], 1)

        bad_network = {
            "nodes": ["s", "t"],
            "edges": [{"id": "e1", "tail": "s", "head": "t",
                       "lower": 5, "upper": 10, "cost": 1}],
            "demands": {"s": -3, "t": 3},
        }
        path = self.write({"network": bad_network, "flow": {"e1": 3}})
        proc = run_cli("repair", path)
        self.assertEqual(proc.returncode, 1)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "infeasible")
        self.assertIsNotNone(result["cut"])
        self.assertGreater(result["cut"]["demand"],
                           result["cut"]["capacity_in"] - result["cut"]["lower_out"])

    def test_usage_error(self):
        proc = run_cli("verify", "/nonexistent/file.json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", proc.stderr.lower())


if __name__ == "__main__":
    unittest.main()
