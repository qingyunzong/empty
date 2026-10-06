import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(request):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "regexamb"],
        input=json.dumps(request),
        capture_output=True, text=True, cwd=REPO_ROOT, env=env,
    )
    return proc


class TestCli(unittest.TestCase):
    def test_pattern_request(self):
        proc = run_cli({"pattern": "a|a"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "ambiguous")
        self.assertEqual(out["word"], "a")
        self.assertEqual(len(out["parses"]), 2)

    def test_ast_request_with_explicit_ids(self):
        request = {"ast": {"id": 7, "kind": "alt", "children": [
            {"id": 8, "kind": "lit", "char": "a"},
            {"id": 9, "kind": "lit", "char": "a"},
        ]}}
        proc = run_cli(request)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "ambiguous")
        used = {p["children"][0]["node"] for p in out["parses"]}
        self.assertEqual(used, {8, 9})

    def test_unambiguous_certificate(self):
        proc = run_cli({"pattern": "a(b|c)d"})
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "unambiguous")
        self.assertEqual(out["certificate"]["type"], "unambiguous")

    def test_epsilon_loop_reported(self):
        proc = run_cli({"pattern": "(a*)*"})
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "ambiguous")
        self.assertEqual(out["word"], "")
        self.assertTrue(out["infinite"])
        self.assertIn("epsilon_loop", out)

    def test_unknown_then_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            ckpt = os.path.join(tmp, "ckpt.json")
            req1 = {"pattern": "aaaa(a|a)", "budget": 1, "checkpoint": ckpt}
            out1 = json.loads(run_cli(req1).stdout)
            self.assertEqual(out1["status"], "unknown")
            self.assertTrue(os.path.exists(ckpt))
            req2 = {"pattern": "aaaa(a|a)", "budget": 50_000_000, "resume": ckpt}
            out2 = json.loads(run_cli(req2).stdout)
            self.assertEqual(out2["status"], "ambiguous")
            self.assertEqual(out2["word"], "aaaaa")

    def test_error_reported_as_json(self):
        proc = run_cli({"pattern": "(a|b"})
        self.assertEqual(proc.returncode, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "error")


if __name__ == "__main__":
    unittest.main()
