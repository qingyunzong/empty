import json
import subprocess
import sys
import unittest

PY = sys.executable


def run_cli(request):
    proc = subprocess.run(
        [PY, "-m", "symregex"], input=json.dumps(request),
        capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


class TestCli(unittest.TestCase):
    def test_match(self):
        out = run_cli({"command": "match", "alphabet": "ab",
                       "pattern": "(a|b)*abb", "string": "aabb"})
        self.assertEqual(out, {"match": True})
        out = run_cli({"command": "match", "alphabet": "ab",
                       "pattern": "~@", "string": ""})
        self.assertEqual(out, {"match": False})

    def test_equivalent_with_proof(self):
        out = run_cli({"command": "equivalent", "alphabet": "ab",
                       "left": "a*", "right": "(a|@)*"})
        self.assertEqual(out["status"], "equivalent")
        self.assertIn("proof", out)
        # 证明可通过 CLI 验证
        chk = run_cli({"command": "verify_proof", "alphabet": "ab",
                       "left": "a*", "right": "(a|@)*", "proof": out["proof"]})
        self.assertEqual(chk, {"valid": True})
        # 篡改证明
        bad = json.loads(json.dumps(out["proof"]))
        bad["edges"] = bad["edges"][1:]
        chk = run_cli({"command": "verify_proof", "alphabet": "ab",
                       "left": "a*", "right": "(a|@)*", "proof": bad})
        self.assertEqual(chk, {"valid": False})

    def test_not_equivalent_counterexample(self):
        out = run_cli({"command": "equivalent", "alphabet": "ab",
                       "left": "a*", "right": "b*"})
        self.assertEqual(out["status"], "different")
        self.assertEqual(out["counterexample"], "a")
        self.assertEqual(out["side"], "left")

    def test_included(self):
        out = run_cli({"command": "included", "alphabet": "ab",
                       "left": "a*", "right": "(a|b)*"})
        self.assertEqual(out["status"], "included")
        out = run_cli({"command": "included", "alphabet": "ab",
                       "left": "(a|b)*", "right": "a*"})
        self.assertEqual(out["status"], "not_included")
        self.assertEqual(out["counterexample"], "b")

    def test_shortest_difference(self):
        out = run_cli({"command": "shortest_difference", "alphabet": "abcd",
                       "left": "da|db", "right": "#"})
        self.assertEqual(out["status"], "different")
        self.assertEqual(out["counterexample"], "da")

    def test_budget_unknown_and_resume(self):
        req = {"command": "shortest_difference", "alphabet": "ab",
               "left": "(a|b)*a(a|b)(a|b)(a|b)",
               "right": "((a|b)(a|b)*)*a(a|b)(a|b)(a|b)", "budget": 1}
        out = run_cli(req)
        self.assertEqual(out["status"], "unknown")
        state = out["state"]
        for _ in range(10000):
            out = run_cli({"command": "resume", "state": state, "budget": 50})
            if out["status"] != "unknown":
                break
            state = out["state"]
        self.assertEqual(out["status"], "equivalent")
        self.assertIn("proof", out)

    def test_resume_tampered_state_rejected(self):
        req = {"command": "shortest_difference", "alphabet": "ab",
               "left": "(a|b)*a", "right": "~(~((a|b)*a))", "budget": 1}
        out = run_cli(req)
        self.assertEqual(out["status"], "unknown")
        state = out["state"]
        state["alphabet"] = "abc"   # 篡改字母表
        out = run_cli({"command": "resume", "state": state})
        self.assertIn("error", out)

    def test_automaton(self):
        out = run_cli({"command": "automaton", "alphabet": "ab",
                       "pattern": "(a|b)*abb"})
        self.assertFalse(out["truncated"])
        self.assertEqual(len(out["minimized"]["states"]), 4)
        ivs = {(t["from"], t["interval"]) for t in out["dfa"]["transitions"]}
        self.assertTrue(ivs)  # 迁移按区间给出

    def test_errors(self):
        out = run_cli({"command": "match", "alphabet": "ab",
                       "pattern": "(", "string": ""})
        self.assertIn("error", out)
        out = run_cli({"command": "nonsense", "alphabet": "ab"})
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
