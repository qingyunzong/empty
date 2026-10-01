import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(args, cwd):
    return subprocess.run(
        [sys.executable, "-m", "scoper"] + args,
        cwd=cwd, capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": ROOT})


class TestCli(unittest.TestCase):
    def test_success_emits_resolved_json(self):
        ast = {"type": "block", "stmts": [
            {"type": "let", "name": "x", "span": [0, 1]},
            {"type": "use", "name": "x", "span": [2, 3]},
            {"type": "use", "name": "print", "span": [4, 5]},
        ]}
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.scp")
            out = os.path.join(d, "resolved.json")
            with open(src, "w") as f:
                json.dump(ast, f)
            proc = run_cli([src, "--emit", out], cwd=d)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(out) as f:
                result = json.load(f)
            self.assertEqual(result["uses"][0]["def_id"], 0)
            self.assertTrue(result["uses"][1]["builtin"])

    def test_scope_error_exit_5_and_no_output(self):
        ast = {"type": "block", "stmts": [
            {"type": "block", "stmts": [
                {"type": "use", "name": "x", "span": [2, 3]},
                {"type": "let", "name": "x", "span": [4, 5]},
            ]},
        ]}
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.scp")
            out = os.path.join(d, "resolved.json")
            with open(src, "w") as f:
                json.dump(ast, f)
            proc = run_cli([src, "--emit", out], cwd=d)
            self.assertEqual(proc.returncode, 5, proc.stderr)
            self.assertFalse(os.path.exists(out))
            err = json.loads(proc.stderr)
            self.assertEqual(err["error"], "ScopeError")
            self.assertEqual(err["kind"], "TDZ")
            self.assertEqual(err["name"], "x")
            self.assertEqual(err["use_span"], [2, 3])
            self.assertEqual(err["def_span"], [4, 5])

    def test_stdout_when_no_emit(self):
        ast = {"type": "block", "stmts": [
            {"type": "const", "name": "k"},
            {"type": "use", "name": "k"},
        ]}
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.scp")
            with open(src, "w") as f:
                json.dump(ast, f)
            proc = run_cli([src], cwd=d)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["uses"][0]["def_id"], 0)


if __name__ == "__main__":
    unittest.main()
