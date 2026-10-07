import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(op, payload):
    env = dict(os.environ)
    env["PYTHONPATH"] = ROOT + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "pathpolicy", op],
        input=json.dumps(payload), capture_output=True, text=True,
        cwd=ROOT, env=env)
    return proc.returncode, json.loads(proc.stdout)


class CliTest(unittest.TestCase):
    def test_normalize(self):
        code, out = run_cli("normalize", {"path": "a//b/./c"})
        self.assertEqual(code, 0)
        self.assertEqual(out["normalized"], "/a/b/c")

    def test_normalize_escape_rejected(self):
        code, out = run_cli("normalize", {"path": "a/../.."})
        self.assertEqual(code, 1)
        self.assertFalse(out["ok"])
        self.assertIn("escapes root", out["error"])

    def test_match(self):
        code, out = run_cli("match", {"pattern": "a/**/b", "path": "/a/b"})
        self.assertEqual(code, 0)
        self.assertTrue(out["match"])
        code, out = run_cli("match", {"pattern": "a?c", "path": "/ac"})
        self.assertFalse(out["match"])

    def test_includes_and_verify(self):
        code, out = run_cli("includes", {
            "left": {"allow": ["a/**"]},
            "right": {"allow": ["**"]}})
        self.assertEqual(code, 0)
        self.assertEqual(out["result"], "included")
        code, out2 = run_cli("verify", {"certificate": out["certificate"]})
        self.assertEqual(code, 0)
        self.assertTrue(out2["valid"])

    def test_difference_witness(self):
        code, out = run_cli("difference", {
            "left": {"allow": ["[ab]"]}, "right": {"allow": ["a"]},
            "all_shortest": True})
        self.assertEqual(code, 0)
        self.assertEqual(out["result"], "nonempty")
        self.assertEqual(out["witness"]["path"], "/b")
        code, out2 = run_cli("verify", {"certificate": out["certificate"]})
        self.assertTrue(out2["valid"])

    def test_equivalent(self):
        code, out = run_cli("equivalent", {
            "left": {"allow": ["a//b/**"]}, "right": {"allow": ["a/./b/**"]}})
        self.assertEqual(code, 0)
        self.assertEqual(out["result"], "equivalent")

    def test_unknown_then_resume(self):
        code, out = run_cli("includes", {
            "left": {"allow": ["a/**"]}, "right": {"allow": ["**"]},
            "budget": 2})
        self.assertEqual(code, 0)
        self.assertEqual(out["result"], "unknown")
        self.assertIn("checkpoint", out)
        code, out2 = run_cli("resume", {
            "checkpoint": out["checkpoint"], "budget": 100000})
        self.assertEqual(code, 0)
        self.assertEqual(out2["result"], "included")

    def test_bad_pattern_error(self):
        code, out = run_cli("match", {"pattern": "a**b", "path": "/a"})
        self.assertEqual(code, 1)
        self.assertFalse(out["ok"])


if __name__ == "__main__":
    unittest.main()
