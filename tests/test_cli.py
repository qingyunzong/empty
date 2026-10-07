import json
import os
import subprocess
import sys
import tempfile
import unittest

EDGES = [
    {"id": "sa", "tail": "S", "head": "A", "lo": 0, "hi": 5, "cost": 1},
    {"id": "at", "tail": "A", "head": "T", "lo": 0, "hi": 5, "cost": 1},
    {"id": "st", "tail": "S", "head": "T", "lo": 0, "hi": 5, "cost": 5},
]

DOC = {
    "nodes": ["S", "A", "T"],
    "edges": EDGES,
    "demands": {"S": -3, "T": 3},
    "operations": [
        {"op": "solve"},
        {"op": "update", "edges": {"sa": {"hi": 1}, "at": {"hi": 1},
                                   "st": {"hi": 1}}},
        {"op": "solve"},
        {"op": "published"},
        {"op": "update", "edges": {"ghost": {"hi": 1}}},
        {"op": "solve"},
        {"op": "published"},
    ],
}

BUDGET_DOC = {
    "nodes": ["S", "A", "T"],
    "edges": EDGES,
    "demands": {"S": -3, "T": 3},
    "operations": [{"op": "solve", "budget": 1}],
}


class TestCli(unittest.TestCase):
    def run_cli(self, doc):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as fh:
            json.dump(doc, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "mincostflow", path],
                capture_output=True, text=True, check=True,
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            )
            return json.loads(proc.stdout)
        finally:
            os.unlink(path)

    def test_cli_end_to_end(self):
        out = self.run_cli(DOC)
        results = out["results"]
        self.assertEqual(len(results), 7)

        # 1) unlimited solve: feasible and optimal, two independent states
        r0 = results[0]
        self.assertEqual(r0["feasibility"], "feasible")
        self.assertEqual(r0["optimality"], "optimal")
        self.assertEqual(r0["cost"], 6)
        self.assertIn("flows", r0)
        self.assertIn("potentials", r0)

        # 2) update ok
        self.assertEqual(results[1], {"op": "update", "ok": True})

        # 3) after severing capacity: infeasible with a cut certificate
        r3 = results[2]
        self.assertEqual(r3["feasibility"], "infeasible")
        self.assertEqual(r3["optimality"], "infeasible")
        self.assertTrue(r3["certificate"])

        # 4) published version is still the old feasible one
        r4 = results[3]
        self.assertTrue(r4["available"])
        self.assertEqual(r4["feasibility"], "feasible")
        self.assertEqual(r4["optimality"], "optimal")
        self.assertEqual(r4["cost"], 6)

        # 5) bad update reported as error, does not crash the session
        r5 = results[4]
        self.assertFalse(r5["ok"])
        self.assertIn("unknown edge id", r5["error"])

        # 6) state unchanged by the failed transaction: still infeasible
        r6 = results[5]
        self.assertEqual(r6["feasibility"], "infeasible")

        # 7) published version still the pre-update feasible one
        r7 = results[6]
        self.assertTrue(r7["available"])
        self.assertEqual(r7["cost"], 6)

    def test_cli_budget_exhausted_not_proven(self):
        out = self.run_cli(BUDGET_DOC)
        r = out["results"][0]
        # feasible but optimality not proven; must never claim "optimal"
        self.assertEqual(r["feasibility"], "feasible")
        self.assertEqual(r["optimality"], "not_proven")
        self.assertIsNone(r["potentials"])

    def test_cli_reads_stdin(self):
        proc = subprocess.run(
            [sys.executable, "-m", "mincostflow"],
            input=json.dumps({"nodes": ["a"], "edges": [],
                              "demands": {}, "operations": [{"op": "solve"}]}),
            capture_output=True, text=True, check=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        out = json.loads(proc.stdout)
        self.assertEqual(out["results"][0]["feasibility"], "feasible")
        self.assertEqual(out["results"][0]["optimality"], "optimal")


if __name__ == "__main__":
    unittest.main()
