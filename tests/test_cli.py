"""CLI tests for `python -m vcmerge merge LEFT RIGHT --out OUT`."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def entry(value, clock, tombstone=False, origin=""):
    return {"value": value, "clock": clock, "tombstone": tombstone, "origin": origin}


def run_cli(*args, cwd=REPO_ROOT):
    return subprocess.run(
        [sys.executable, "-m", "vcmerge", *args],
        capture_output=True, text=True, cwd=cwd,
    )


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, name, doc):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        return path

    def merge(self, left_doc, right_doc, out_name="out.json"):
        left = self.write("left.json", left_doc)
        right = self.write("right.json", right_doc)
        out = os.path.join(self.tmp.name, out_name)
        proc = run_cli("merge", left, right, "--out", out)
        return proc, out


class CliMerge(CliTestCase):
    def test_merge_writes_canonical_out_and_prints_conflicts(self):
        left = {"b": entry(1, {"A": 1}, origin="A"),
                "k": entry("beta", {"A": 1}, origin="A")}
        right = {"k": entry("alpha", {"B": 1}, origin="B"),
                 "a": entry(2, {"B": 2}, origin="B")}
        proc, out = self.merge(left, right)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "1")  # one conflict
        self.assertEqual(proc.stderr, "")
        with open(out, encoding="utf-8") as fh:
            text = fh.read()
        doc = json.loads(text)
        self.assertEqual(doc["k"]["value"], "alpha")
        self.assertTrue(doc["k"]["conflict"])
        self.assertEqual(doc["a"]["value"], 2)
        self.assertEqual(doc["b"]["value"], 1)
        # canonical: sorted keys, compact separators
        self.assertEqual(text, json.dumps(doc, sort_keys=True,
                                          separators=(",", ":"),
                                          ensure_ascii=False) + "\n")

    def test_no_conflicts_prints_zero(self):
        proc, _ = self.merge({"k": entry(1, {"A": 1}, origin="A")},
                             {"k": entry(2, {"A": 2}, origin="A")})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "0")

    def test_repeated_runs_byte_identical(self):
        left = {"k": entry("x", {"A": 1}, origin="A")}
        right = {"k": entry("y", {"B": 1}, origin="B")}
        proc1, out1 = self.merge(left, right, "o1.json")
        proc2, out2 = self.merge(left, right, "o2.json")
        self.assertEqual(proc1.returncode, 0, proc1.stderr)
        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        with open(out1, "rb") as fh:
            b1 = fh.read()
        with open(out2, "rb") as fh:
            b2 = fh.read()
        self.assertEqual(b1, b2)

    def test_commuted_cli_invocations_agree(self):
        left = {"k": entry("x", {"A": 1}, origin="A")}
        right = {"k": entry("y", {"B": 1}, origin="B")}
        l = self.write("l.json", left)
        r = self.write("r.json", right)
        o1 = os.path.join(self.tmp.name, "o1.json")
        o2 = os.path.join(self.tmp.name, "o2.json")
        p1 = run_cli("merge", l, r, "--out", o1)
        p2 = run_cli("merge", r, l, "--out", o2)
        self.assertEqual(p1.returncode, 0, p1.stderr)
        self.assertEqual(p2.returncode, 0, p2.stderr)
        with open(o1, "rb") as fh:
            self.assertEqual(fh.read(), open(o2, "rb").read())


class CliErrors(CliTestCase):
    def test_negative_counter_exit_code_3(self):
        bad = {"k": entry("v", {"A": -1}, origin="A")}
        good = {"k": entry("w", {"B": 1}, origin="B")}
        proc, _ = self.merge(bad, good)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("negative", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_missing_file_exit_code_2(self):
        good = self.write("good.json", {})
        out = os.path.join(self.tmp.name, "out.json")
        proc = run_cli("merge", good, os.path.join(self.tmp.name, "nope.json"),
                       "--out", out)
        self.assertEqual(proc.returncode, 2)
        self.assertNotEqual(proc.stderr, "")

    def test_invalid_json_exit_code_2(self):
        bad = os.path.join(self.tmp.name, "bad.json")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        good = self.write("good.json", {})
        out = os.path.join(self.tmp.name, "out.json")
        proc = run_cli("merge", bad, good, "--out", out)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("invalid JSON", proc.stderr)


if __name__ == "__main__":
    unittest.main()
