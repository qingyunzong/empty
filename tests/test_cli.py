import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(req):
    proc = subprocess.run(
        [sys.executable, "-m", "regex_deriv"],
        input=json.dumps(req), capture_output=True, text=True, cwd=ROOT)
    if proc.returncode != 0:
        raise AssertionError(f"cli failed: {proc.stderr}")
    return json.loads(proc.stdout)


class TestCLI(unittest.TestCase):
    def test_parse(self):
        out = run_cli({"op": "parse", "alphabet": "ab", "pattern": "a|b"})
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["expr"][0], "union")

    def test_match(self):
        out = run_cli({"op": "match", "alphabet": "ab",
                       "pattern": "a*b", "string": "aab"})
        self.assertTrue(out["match"])
        out = run_cli({"op": "match", "alphabet": "ab",
                       "pattern": "a*b", "string": "aba"})
        self.assertFalse(out["match"])

    def test_equivalent_with_proof(self):
        out = run_cli({"op": "equivalent", "alphabet": "ab",
                       "r1": "a(ba)*", "r2": "(ab)*a"})
        self.assertEqual(out["status"], "equivalent")
        self.assertIn("proof", out)
        chk = run_cli({"op": "verify_proof", "alphabet": "ab",
                       "r1": "a(ba)*", "r2": "(ab)*a",
                       "proof": out["proof"]})
        self.assertTrue(chk["valid"])

    def test_shortest_difference(self):
        out = run_cli({"op": "shortest_difference", "alphabet": "abc",
                       "r1": "a|c", "r2": "b"})
        self.assertEqual(out["status"], "different")
        self.assertEqual(out["witness"], "a")

    def test_included(self):
        out = run_cli({"op": "included", "alphabet": "ab",
                       "r1": "a*", "r2": "(a|b)*"})
        self.assertEqual(out["status"], "included")

    def test_budget_and_resume_roundtrip(self):
        req = {"op": "equivalent", "alphabet": "ab",
               "r1": "a(ba)*", "r2": "(ab)*a", "budget": 1}
        out = run_cli(req)
        self.assertEqual(out["status"], "unknown")
        req.pop("budget")
        req["frontier"] = out["frontier"]
        out = run_cli(req)
        self.assertEqual(out["status"], "equivalent")

    def test_resume_binding_mismatch(self):
        out = run_cli({"op": "equivalent", "alphabet": "ab",
                       "r1": "a(ba)*", "r2": "(ab)*a", "budget": 1})
        bad = run_cli({"op": "equivalent", "alphabet": "ab",
                       "r1": "a(ba)*", "r2": "(ab)*b",
                       "frontier": out["frontier"]})
        self.assertEqual(bad["status"], "error")

    def test_minimize(self):
        out = run_cli({"op": "minimize", "alphabet": "ab",
                       "pattern": "(a|b)*ab"})
        self.assertEqual(out["status"], "ok")
        self.assertEqual(len(out["dfa"]["states"]), 3)

    def test_structured_expression_input(self):
        out = run_cli({"op": "match", "alphabet": "ab",
                       "pattern": ["star", ["char", 97, 97]], "string": "aaa"})
        self.assertTrue(out["match"])

    def test_error_status(self):
        out = run_cli({"op": "nonsense", "alphabet": "ab"})
        self.assertEqual(out["status"], "error")


if __name__ == "__main__":
    unittest.main()
