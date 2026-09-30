import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from merklesync import (EMPTY_HASH, OrderError, ParseError, diff_streams,
                        parse_stream)

REPO_ROOT = Path(__file__).resolve().parent.parent


def make_records(keys_values):
    """Canonical JSONL text from a list of (key, value) pairs."""
    return "".join(
        json.dumps([k, v], ensure_ascii=False, sort_keys=True,
                   separators=(",", ":")) + "\n"
        for k, v in keys_values)


def reference_diff(a_items, b_items):
    """Plain per-key reference diff over dicts."""
    diff = []
    for key in sorted(set(a_items) | set(b_items)):
        va, vb = a_items.get(key), b_items.get(key)
        if key not in a_items or key not in b_items or va != vb:
            diff.append({"key": key,
                         "a": a_items.get(key),
                         "b": b_items.get(key)})
    return diff


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "merklesync", *args],
        cwd=REPO_ROOT, capture_output=True, text=True)


class RandomizedDiffTest(unittest.TestCase):
    """Acceptance A: random mutation injection must match a per-key
    reference diff exactly."""

    def test_random_injection_matches_reference(self):
        rng = random.Random(20261001)
        for trial in range(30):
            n = rng.randint(0, 300)
            keys = sorted(rng.sample(range(10**6), n))
            a_items = {f"k{key:06d}": rng.randint(0, 10**9) for key in keys}
            b_items = dict(a_items)
            # Inject random mutations: value changes, deletions, insertions.
            for _ in range(rng.randint(0, 40)):
                op = rng.choice(["set", "del", "ins"])
                if op == "set" and b_items:
                    k = rng.choice(list(b_items))
                    b_items[k] = rng.randint(0, 10**9)
                elif op == "del" and b_items:
                    del b_items[rng.choice(list(b_items))]
                else:
                    b_items[f"k{rng.randint(10**6, 2 * 10**6)}"] = rng.randint(0, 9)
            a_stream = parse_stream(make_records(sorted(a_items.items())))
            b_stream = parse_stream(make_records(sorted(b_items.items())))
            result = diff_streams(a_stream, b_stream, max_rounds=64)
            expected = reference_diff(a_items, b_items)
            got = sorted(result["diff"], key=lambda e: e["key"])
            self.assertFalse(result["incomplete"], f"trial {trial}")
            self.assertEqual(got, expected, f"trial {trial}")
            self.assertEqual(result["equal"], not expected, f"trial {trial}")


class WhitespaceTest(unittest.TestCase):
    """Acceptance B: pure formatting/whitespace differences must compare
    equal (identical root hash despite different bytes)."""

    def test_whitespace_only_difference_is_equal(self):
        items = [("a", 1), ("b", {"x": [1, 2, 3], "y": "z"}), ("c", None)]
        text_a = make_records(items)
        text_b = ('[ "a" , 1 ]\n'
                  '[   "b",   { "y" : "z" , "x" : [ 1 ,2, 3 ] }  ]\n'
                  '["c",null]\n')
        self.assertNotEqual(text_a, text_b)
        result = diff_streams(parse_stream(text_a), parse_stream(text_b),
                              max_rounds=4)
        self.assertTrue(result["equal"])
        self.assertEqual(result["diff"], [])
        self.assertFalse(result["incomplete"])

    def test_empty_interval_hash_constant(self):
        empty = parse_stream("")
        self.assertEqual(empty.range_hash(None, None), EMPTY_HASH)


class IncompleteTest(unittest.TestCase):
    """Acceptance C: with R=1 the protocol must report incomplete and must
    not fabricate concrete differing keys."""

    def test_one_round_is_incomplete(self):
        a_text = make_records([(f"k{i:03d}", i) for i in range(50)])
        b_text = make_records([(f"k{i:03d}", i * 2) for i in range(50)])
        with tempfile.TemporaryDirectory() as tmp:
            pa = Path(tmp) / "a.jsonl"
            pb = Path(tmp) / "b.jsonl"
            pa.write_text(a_text, encoding="utf-8")
            pb.write_text(b_text, encoding="utf-8")
            proc = run_cli("diff", str(pa), str(pb), "--max-rounds", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["incomplete"])
        self.assertFalse(out["equal"])
        self.assertEqual(out["rounds"], 1)
        self.assertEqual(out["diff"], [])  # no leaf reached: no invented keys
        self.assertTrue(out["suspects"])

    def test_enough_rounds_complete(self):
        a = parse_stream(make_records([(f"k{i:03d}", i) for i in range(50)]))
        b = parse_stream(make_records([(f"k{i:03d}", i + 1000) for i in range(50)]))
        result = diff_streams(a, b, max_rounds=64)
        self.assertFalse(result["incomplete"])
        self.assertEqual(len(result["diff"]), 50)

    def test_equal_streams_finish_immediately(self):
        text = make_records([(f"k{i:03d}", i) for i in range(10)])
        result = diff_streams(parse_stream(text), parse_stream(text),
                              max_rounds=1)
        self.assertTrue(result["equal"])
        self.assertFalse(result["incomplete"])
        self.assertEqual(result["rounds"], 1)


class OrderValidationTest(unittest.TestCase):
    """Acceptance D: out-of-order input exits with code 3 (duplicates too)."""

    def _write_and_run(self, a_text, b_text):
        with tempfile.TemporaryDirectory() as tmp:
            pa = Path(tmp) / "a.jsonl"
            pb = Path(tmp) / "b.jsonl"
            pa.write_text(a_text, encoding="utf-8")
            pb.write_text(b_text, encoding="utf-8")
            return run_cli("diff", str(pa), str(pb))

    def test_unordered_input_exit_code_3(self):
        good = make_records([("a", 1), ("b", 2)])
        bad = make_records([("b", 2), ("a", 1)])
        proc = self._write_and_run(good, bad)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("error", proc.stderr.lower())
        self.assertEqual(proc.stdout, "")

    def test_duplicate_key_exit_code_3(self):
        dup = make_records([("a", 1), ("a", 2)])
        good = make_records([("a", 1)])
        proc = self._write_and_run(dup, good)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("duplicate", proc.stderr.lower())

    def test_library_raises_order_error(self):
        with self.assertRaises(OrderError):
            parse_stream(make_records([("b", 1), ("a", 2)]))
        with self.assertRaises(OrderError):
            parse_stream(make_records([("a", 1), ("a", 1)]))


class CliMiscTest(unittest.TestCase):
    def test_invalid_json_exit_code_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            pa = Path(tmp) / "a.jsonl"
            pb = Path(tmp) / "b.jsonl"
            pa.write_text("not json\n", encoding="utf-8")
            pb.write_text("", encoding="utf-8")
            proc = run_cli("diff", str(pa), str(pb))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", proc.stderr.lower())

    def test_missing_file_exit_code_2(self):
        proc = run_cli("diff", "/nonexistent/a.jsonl", "/nonexistent/b.jsonl")
        self.assertEqual(proc.returncode, 2)

    def test_library_rejects_bad_record(self):
        with self.assertRaises(ParseError):
            parse_stream('{"key": "a"}\n')

    def test_cli_output_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            pa = Path(tmp) / "a.jsonl"
            pb = Path(tmp) / "b.jsonl"
            pa.write_text(make_records([("a", 1), ("b", 2)]), encoding="utf-8")
            pb.write_text(make_records([("a", 1), ("b", 3), ("c", 4)]),
                          encoding="utf-8")
            proc = run_cli("diff", str(pa), str(pb), "--max-rounds", "16")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        for field in ("equal", "diff", "rounds", "incomplete"):
            self.assertIn(field, out)
        self.assertFalse(out["equal"])
        self.assertFalse(out["incomplete"])
        self.assertEqual(out["diff"], [{"key": "b", "a": 2, "b": 3},
                                       {"key": "c", "a": None, "b": 4}])

    def test_both_empty_are_equal(self):
        result = diff_streams(parse_stream(""), parse_stream(""), max_rounds=1)
        self.assertTrue(result["equal"])
        self.assertEqual(result["diff"], [])


if __name__ == "__main__":
    unittest.main()
