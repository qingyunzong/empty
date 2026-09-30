"""End-to-end CLI tests for `python -m jsonmerge3`."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write_json(directory, name, value):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        if isinstance(value, str):
            handle.write(value)
        else:
            json.dump(value, handle)
    return path


def run_cli(*argv):
    return subprocess.run(
        [sys.executable, "-m", "jsonmerge3", *argv],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def test_clean_merge_exit_0(self):
        base = write_json(self.dir, "base.json", {"a": {"b": 1}, "l": [1, 2]})
        ours = write_json(self.dir, "ours.json", {"a": {"b": 2}, "l": [1, 2, 3]})
        theirs = write_json(self.dir, "theirs.json", {"a": {"b": 1}, "l": [1, 9]})
        out = os.path.join(self.dir, "result.json")
        proc = run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        expected = {"a": {"b": 2}, "l": [1, 9, 3]}
        self.assertEqual(json.loads(proc.stdout), expected)
        self.assertEqual(json.loads(proc.stderr), [])
        with open(out, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), expected)

    def test_conflict_exit_1_and_pointer_on_stderr(self):
        base = write_json(self.dir, "base.json", {"gone": 1, "keep": 2})
        ours = write_json(self.dir, "ours.json", {"keep": 2})
        theirs = write_json(self.dir, "theirs.json", {"gone": 5, "keep": 2})
        out = os.path.join(self.dir, "result.json")
        proc = run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {"keep": 2})
        self.assertEqual(json.loads(proc.stderr), ["/gone"])
        with open(out, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), {"keep": 2})

    def test_invalid_json_exit_2_and_no_output_written(self):
        base = write_json(self.dir, "base.json", "{not json")
        ours = write_json(self.dir, "ours.json", {"a": 1})
        theirs = write_json(self.dir, "theirs.json", {"a": 2})
        out = os.path.join(self.dir, "result.json")
        proc = run_cli(base, ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertIn("error", proc.stderr)
        self.assertFalse(os.path.exists(out))

    def test_missing_input_file_exit_2(self):
        ours = write_json(self.dir, "ours.json", {"a": 1})
        theirs = write_json(self.dir, "theirs.json", {"a": 2})
        out = os.path.join(self.dir, "result.json")
        proc = run_cli(os.path.join(self.dir, "nope.json"), ours, theirs, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertFalse(os.path.exists(out))

    def test_usage_error_exit_2(self):
        proc = run_cli()
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
