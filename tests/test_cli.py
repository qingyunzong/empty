import json
import os
import subprocess
import sys
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(command, params):
    proc = subprocess.run(
        [sys.executable, "-m", "algroots", command],
        input=json.dumps(params), capture_output=True, text=True,
        cwd=REPO_ROOT)
    return proc.returncode, json.loads(proc.stdout)


class TestCli(unittest.TestCase):
    def test_isolate(self):
        code, out = run_cli("isolate", {"poly": ["-2", "0", "1"]})
        self.assertEqual(code, 0)
        self.assertEqual(out["status"], "done")
        self.assertEqual(len(out["roots"]), 2)
        self.assertEqual(out["roots"][1]["multiplicity"], 1)
        self.assertIn("certificate", out)

    def test_isolate_budget_then_resume(self):
        code, out = run_cli("isolate", {"poly": ["0", "-4", "0", "1"],
                                        "budget": 1})
        self.assertEqual(code, 0)
        self.assertEqual(out["status"], "pending")
        state = out["state"]
        for _ in range(1000):
            code, out = run_cli("isolate", {"state": state, "budget": 4})
            self.assertEqual(code, 0)
            if out["status"] == "done":
                break
            state = out["state"]
        self.assertEqual(out["status"], "done")
        self.assertEqual(len(out["roots"]), 3)
        self.assertEqual(out["roots"][1]["type"], "point")
        self.assertEqual(out["roots"][1]["value"], "0")

    def test_refine(self):
        code, out = run_cli("refine", {"poly": ["-2", "0", "1"], "index": 1,
                                       "epsilon": "1/1000"})
        self.assertEqual(code, 0)
        self.assertTrue(out["refined"])
        root = out["root"]
        from fractions import Fraction
        width = Fraction(root["upper"]) - Fraction(root["lower"])
        self.assertLessEqual(width, Fraction(1, 1000))

    def test_compare(self):
        code, out = run_cli("compare", {
            "poly1": ["-2", "0", "1"], "index1": 1,
            "poly2": ["-3", "0", "1"], "index2": 1})
        self.assertEqual(code, 0)
        self.assertEqual(out["relation"], "lt")
        code, out = run_cli("compare", {
            "poly1": ["-2", "0", "1"], "index1": 1,
            "poly2": ["14", "-2", "-7", "1"], "index2": 1})  # (x^2-2)(x-7)
        self.assertEqual(out["relation"], "eq")

    def test_verify(self):
        code, out = run_cli("isolate", {"poly": ["0", "-4", "0", "1"]})
        cert = out["certificate"]
        code, out = run_cli("verify", {"certificate": cert})
        self.assertEqual(code, 0)
        self.assertTrue(out["valid"])
        cert["factors"][0]["variations"]["at_lower_bound"] += 1
        code, out = run_cli("verify", {"certificate": cert})
        self.assertFalse(out["valid"])
        self.assertTrue(out["errors"])

    def test_zero_polynomial_error(self):
        code, out = run_cli("isolate", {"poly": ["0", "0"]})
        self.assertEqual(code, 1)
        self.assertIn("error", out)

    def test_constant_polynomial(self):
        code, out = run_cli("isolate", {"poly": ["5"]})
        self.assertEqual(code, 0)
        self.assertEqual(out["roots"], [])


if __name__ == "__main__":
    unittest.main()
