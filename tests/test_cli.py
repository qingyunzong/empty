import json
import subprocess
import sys
import unittest
from fractions import Fraction as F


def run_cli(spec):
    proc = subprocess.run(
        [sys.executable, "-m", "ridag"],
        input=json.dumps(spec), capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError("cli failed: %s" % proc.stderr)
    return json.loads(proc.stdout)


X = {"op": "var", "name": "x"}


def const(v):
    return {"op": "const", "value": str(v)}


class TestCli(unittest.TestCase):
    def test_isolate_with_verification(self):
        spec = {
            "expression": {"op": "sub", "args": [
                {"op": "mul", "args": [const(2), X]}, const(3)]},
            "variables": {"x": [["0", "5", True, True]]},
            "isolate": {"var": "x", "budget": 1000},
            "verify": True,
        }
        out = run_cli(spec)
        self.assertEqual(out["verification"], "ok")
        labels = [o["label"] for o in out["outputs"]]
        self.assertIn("unique", labels)
        for o in out["outputs"]:
            if o["label"] == "unique":
                lo, hi = F(o["interval"][0]), F(o["interval"][1])
                self.assertTrue(lo <= F(3, 2) <= hi)

    def test_evaluate_division_split(self):
        spec = {
            "expression": {"op": "div", "args": [const(1), X]},
            "variables": {"x": [["-1", "1", True, True]]},
            "evaluate": True,
        }
        out = run_cli(spec)
        self.assertTrue(out["hole"])
        self.assertEqual(len(out["value"]), 2)  # two rays, not whole reals
        self.assertEqual(out["value"][0][1], "-1")
        self.assertEqual(out["value"][1][0], "1")

    def test_evaluate_conditional(self):
        spec = {
            "expression": {"op": "if", "cond": X,
                           "then": const(5), "else": const(7)},
            "variables": {"x": [["1", "2", True, True]]},
            "evaluate": True,
        }
        out = run_cli(spec)
        self.assertEqual(out["value"], [["5", "5", True, True]])

    def test_undecided_kept_when_budget_tiny(self):
        spec = {
            "expression": {"op": "sub", "args": [
                {"op": "pow", "arg": X, "exp": 3}, X]},
            "variables": {"x": [["-1", "1", True, True]]},
            "isolate": {"var": "x", "budget": 1},
            "verify": True,
        }
        out = run_cli(spec)
        self.assertTrue(out["outputs"])
        self.assertTrue(any(o["label"] == "undecided"
                            for o in out["outputs"]))
        self.assertEqual(out["verification"], "ok")


if __name__ == "__main__":
    unittest.main()
