import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_cli(self, *args, expect=0):
        proc = subprocess.run(
            [sys.executable, "-m", "jsondoc", "--dir", self.tmp.name, *args],
            capture_output=True, text=True, cwd=ROOT,
        )
        self.assertEqual(proc.returncode, expect, proc.stderr)
        return proc

    def out_json(self, *args):
        proc = self.run_cli(*args)
        return json.loads(proc.stdout)

    def test_end_to_end_flow(self):
        self.assertEqual(
            self.out_json("put", "d1", '{"n": 1, "tags": ["a", "b"]}'),
            {"version": 1})
        self.assertEqual(
            self.out_json("put", "d2", '{"n": 2, "tags": ["b"]}'),
            {"version": 2})
        self.out_json("index", "by_n", "/n")
        self.out_json("index", "by_tag", "/tags/*")
        self.assertEqual(
            self.out_json("apply", "d1",
                          '[{"op": "replace", "path": "/n", "value": 5}]'),
            {"version": 3})
        self.assertEqual(self.out_json("get", "d1"),
                         {"n": 5, "tags": ["a", "b"]})
        self.assertEqual(
            self.out_json("query", '{"where": [{"eq": ["by_n", 5]}]}'),
            {"result": ["d1"]})
        self.assertEqual(
            self.out_json("query", '{"order_by": "by_n"}'),
            {"result": ["d2", "d1"]})
        self.assertEqual(
            self.out_json("query", '{"where": [{"eq": ["by_tag", "b"]},'
                                   ' {"exists": "/n"}]}'),
            {"result": ["d1", "d2"]})
        versions = self.out_json("versions")
        self.assertEqual(versions["latest"], 3)
        self.assertIn(3, versions["versions"])
        self.assertIn("versions", self.out_json("gc"))

    def test_decimal_and_int_stay_distinct(self):
        self.out_json("put", "d1", '{"p": 1}')
        self.out_json("put", "d2", '{"p": 1.0}')
        self.out_json("index", "by_p", "/p")
        self.assertEqual(
            self.out_json("query", '{"where": [{"eq": ["by_p", 1]}]}'),
            {"result": ["d1"]})
        self.assertEqual(
            self.out_json("query", '{"where": [{"eq": ["by_p", 1.0]}]}'),
            {"result": ["d2"]})

    def test_duplicate_keys_rejected(self):
        proc = self.run_cli("put", "bad", '{"a": 1, "a": 2}', expect=2)
        self.assertIn("DuplicateKeyError", proc.stderr)

    def test_failed_patch_is_rolled_back(self):
        self.out_json("put", "d1", '{"n": 1}')
        proc = self.run_cli(
            "apply", "d1",
            '[{"op": "add", "path": "/x", "value": 1},'
            ' {"op": "test", "path": "/n", "value": 42}]',
            expect=2)
        self.assertIn("PatchError", proc.stderr)
        self.assertEqual(self.out_json("get", "d1"), {"n": 1})
        self.assertEqual(self.out_json("versions")["latest"], 1)


if __name__ == "__main__":
    unittest.main()

