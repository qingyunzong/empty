import json
import pathlib
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent

A_UNION_A = {
    "type": "union", "id": 3,
    "children": [
        {"type": "lit", "char": "a", "id": 1},
        {"type": "lit", "char": "a", "id": 2},
    ],
}

NESTED_STAR = {"type": "star", "id": 2,
               "child": {"type": "star", "id": 1,
                         "child": {"type": "lit", "char": "a", "id": 3}}}


def run_cli(payload):
    proc = subprocess.run([sys.executable, "-m", "regex_ambiguity"],
                          input=json.dumps(payload), capture_output=True,
                          text=True, cwd=ROOT)
    if proc.returncode != 0:
        raise AssertionError(f"CLI failed: {proc.stderr}")
    return json.loads(proc.stdout)


class CliTest(unittest.TestCase):
    def test_analyze_ambiguous(self):
        res = run_cli({"op": "analyze", "ast": A_UNION_A})
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], "a")
        self.assertFalse(res["infinite"])

    def test_analyze_pumpable(self):
        res = run_cli({"op": "analyze", "ast": NESTED_STAR})
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], "")
        self.assertTrue(res["infinite"])
        self.assertIn("star_id", res["pump"])

    def test_analyze_unambiguous_certificate(self):
        ast = {"type": "cat", "children": [
            {"type": "star", "child": {"type": "lit", "char": "a"}},
            {"type": "lit", "char": "b"}]}
        res = run_cli({"op": "analyze", "ast": ast})
        self.assertEqual(res["status"], "unambiguous")
        self.assertIn("certificate", res)

    def test_verify_roundtrip_and_tamper(self):
        res = run_cli({"op": "analyze", "ast": A_UNION_A})
        parse = res["parses"][0]
        ok = run_cli({"op": "verify", "ast": A_UNION_A, "word": "a",
                      "parse": parse})
        self.assertTrue(ok["valid"], ok)
        tampered = json.loads(json.dumps(parse))
        tampered["span"][1] = 5
        bad = run_cli({"op": "verify", "ast": A_UNION_A, "word": "a",
                       "parse": tampered})
        self.assertFalse(bad["valid"])
        self.assertIn("error", bad)

    def test_budget_unknown_and_resume(self):
        ast = {"type": "cat", "children": [
            {"type": "lit", "char": "a"},
            {"type": "lit", "char": "a"},
            {"type": "union", "children": [
                {"type": "lit", "char": "b"},
                {"type": "lit", "char": "b"}]}]}
        res0 = run_cli({"op": "analyze", "ast": ast,
                        "budget": {"max_steps": 0}})
        self.assertEqual(res0["status"], "unknown")
        res1 = run_cli({"op": "analyze", "ast": ast,
                        "budget": {"max_steps": 1000000},
                        "resume": res0["resume"]})
        self.assertEqual(res1["status"], "ambiguous")
        self.assertEqual(res1["word"], "aab")

    def test_bad_input_reported_as_json(self):
        res = run_cli({"op": "analyze", "ast": {"type": "bogus"}})
        self.assertIn("error", res)


if __name__ == "__main__":
    unittest.main()
