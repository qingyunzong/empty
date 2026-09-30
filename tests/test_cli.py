import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "propcore", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write_spec(self, spec, name="spec.json"):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(spec, handle)
        return path

    def test_passing_spec_exit_0(self):
        spec = self.write_spec({"properties": [
            {"name": "ok", "gen": {"type": "int", "min": 0, "max": 3},
             "expr": "value < 10"},
        ]})
        proc = run_cli("test", spec, "--runs", "20", "--seed", "11")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "PASS")
        self.assertEqual(out["runs"], 20)
        self.assertEqual(out["failures"], [])
        self.assertEqual(out["shrinks"], 0)
        self.assertEqual(set(out), {"status", "runs", "failures", "shrinks"})

    def test_failing_spec_exit_1_then_known_fail_exit_0(self):
        spec = self.write_spec({"properties": [
            {"name": "bad", "gen": {"type": "int", "min": 0, "max": 5},
             "expr": "value < 4"},
        ]})
        db = os.path.join(self.tmp.name, "cache.json")
        first = run_cli("test", spec, "--runs", "50", "--seed", "11",
                        "--db", db)
        self.assertEqual(first.returncode, 1, first.stderr)
        out = json.loads(first.stdout)
        self.assertEqual(out["status"], "FAIL")
        self.assertEqual(out["failures"][0]["value"], 4)

        second = run_cli("test", spec, "--runs", "50", "--seed", "11",
                         "--db", db)
        self.assertEqual(second.returncode, 0, second.stderr)
        out = json.loads(second.stdout)
        self.assertEqual(out["status"], "KNOWN_FAIL")
        self.assertEqual(out["failures"][0]["value"], 4)
        self.assertIs(out["failures"][0]["known"], True)

    def test_invalid_specs_exit_2(self):
        bad_json = os.path.join(self.tmp.name, "bad.json")
        with open(bad_json, "w", encoding="utf-8") as handle:
            handle.write("{nope")
        cases = [
            bad_json,
            os.path.join(self.tmp.name, "missing.json"),
            self.write_spec({"properties": []}),
            self.write_spec({"properties": [
                {"name": "x", "gen": {"type": "nope"}, "expr": "True"},
            ]}),
            self.write_spec({"properties": [
                {"name": "x", "gen": {"type": "int", "min": 5, "max": 1},
                 "expr": "True"},
            ]}),
            self.write_spec({"properties": [
                {"name": "x", "gen": {"type": "int", "min": 0, "max": 1},
                 "expr": "value +"},
            ]}),
        ]
        for path in cases:
            proc = run_cli("test", path)
            self.assertEqual(proc.returncode, 2, "spec %s: %s" % (path, proc))
            self.assertIn("invalid spec", proc.stderr)

    def test_runs_must_be_positive(self):
        spec = self.write_spec({"properties": [
            {"name": "ok", "gen": {"type": "int", "min": 0, "max": 1},
             "expr": "True"},
        ]})
        proc = run_cli("test", spec, "--runs", "0")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
