import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from jsonmerge3 import MISSING, merge3, pointer_of

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def oracle(base, ours, theirs):
    """Independent oracle: enumerate every path of the union tree
    recursively, decide each path with the three-way rules, and assemble
    the expected (merged_value, conflict_path_set). Missing is null."""

    def norm(value):
        return None if value is MISSING else value

    def child(value, key):
        if isinstance(value, dict) and key in value:
            return value[key]
        if isinstance(value, list) and isinstance(key, int) and key < len(value):
            return value[key]
        return MISSING

    def union_children(*values):
        keys = []
        for value in values:
            if isinstance(value, dict):
                items = value.keys()
            elif isinstance(value, list):
                items = range(len(value))
            else:
                continue
            for key in items:
                if key not in keys:
                    keys.append(key)
        return keys

    conflicts = set()

    def walk(b, o, t, path):
        b, o, t = norm(b), norm(o), norm(t)
        if isinstance(o, dict) and isinstance(t, dict):
            b_keys = b if isinstance(b, dict) else None
            return {
                k: walk(child(b, k), child(o, k), child(t, k), path + (k,))
                for k in union_children(b_keys, o, t)
            }
        if isinstance(o, list) and isinstance(t, list):
            b_items = b if isinstance(b, list) else None
            return [
                walk(child(b, i), child(o, i), child(t, i), path + (i,))
                for i in union_children(b_items, o, t)
            ]
        if o == t:
            return o
        if b == o:
            return t
        if b == t:
            return o
        conflicts.add(path)
        return o

    merged = walk(base, ours, theirs, ())
    return merged, conflicts


def run_cli(*args, cwd=None):
    return subprocess.run(
        [sys.executable, "-m", "jsonmerge3", *args],
        capture_output=True,
        text=True,
        cwd=cwd or ROOT,
    )


def write_json(directory, name, value):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh)
    return path


class MergeUnitTests(unittest.TestCase):
    def test_nested_object_non_conflicting_edits(self):
        base = {"a": {"x": 1, "y": 2}, "b": {"p": 1, "q": 2}}
        ours = {"a": {"x": 10, "y": 2}, "b": {"p": 1, "q": 2}}
        theirs = {"a": {"x": 1, "y": 2}, "b": {"p": 1, "q": 20}}
        conflicts = []
        merged = merge3(base, ours, theirs, conflicts=conflicts)
        self.assertEqual(conflicts, [])
        self.assertEqual(merged, {"a": {"x": 10, "y": 2}, "b": {"p": 1, "q": 20}})

    def test_delete_vs_modify_same_key_conflicts(self):
        base = {"k": 1, "keep": True}
        ours = {"keep": True}  # deleted "k"
        theirs = {"k": 2, "keep": True}  # modified "k"
        conflicts = []
        merged = merge3(base, ours, theirs, conflicts=conflicts)
        self.assertEqual([pointer_of(p) for p in conflicts], ["/k"])
        self.assertIsNone(merged["k"])  # deletion treated as null, ours kept
        self.assertTrue(merged["keep"])

    def test_both_delete_same_key_is_clean(self):
        conflicts = []
        merged = merge3({"k": 1}, {}, {}, conflicts=conflicts)
        self.assertEqual(conflicts, [])
        self.assertEqual(merged, {"k": None})

    def test_array_append_one_side_modify_other_side(self):
        base = [1, 2, 3]
        ours = [1, 2, 3, 4]  # appended
        theirs = [1, 20, 3]  # modified existing element
        conflicts = []
        merged = merge3(base, ours, theirs, conflicts=conflicts)
        self.assertEqual(conflicts, [])
        self.assertEqual(merged, [1, 20, 3, 4])

    def test_array_same_new_index_different_values_conflict(self):
        base = [1]
        ours = [1, "a"]
        theirs = [1, "b"]
        conflicts = []
        merged = merge3(base, ours, theirs, conflicts=conflicts)
        self.assertEqual([pointer_of(p) for p in conflicts], ["/1"])
        self.assertEqual(merged, [1, "a"])

    def test_array_same_append_same_value_is_clean(self):
        conflicts = []
        merged = merge3([1], [1, 9], [1, 9], conflicts=conflicts)
        self.assertEqual(conflicts, [])
        self.assertEqual(merged, [1, 9])

    def test_added_key_same_and_different(self):
        conflicts = []
        merged = merge3({}, {"n": 5}, {"n": 5}, conflicts=conflicts)
        self.assertEqual((merged, conflicts), ({"n": 5}, []))
        conflicts = []
        merged = merge3({}, {"n": 5}, {"n": 6}, conflicts=conflicts)
        self.assertEqual([pointer_of(p) for p in conflicts], ["/n"])

    def test_pointer_escaping(self):
        self.assertEqual(pointer_of(("a/b", "~c", 0)), "/a~1b/~0c/0")
        self.assertEqual(pointer_of(()), "")


class OraclePropertyTests(unittest.TestCase):
    """Cross-check merge3 against the independent path-enumeration oracle
    on randomly generated trees of depth <= 3."""

    LEAVES = [None, 0, 1, 2, "a", "b", True]

    def random_tree(self, rng, depth):
        if depth >= 3 or rng.random() < 0.45:
            return rng.choice(self.LEAVES)
        if rng.random() < 0.5:
            return {
                rng.choice("xyz"): self.random_tree(rng, depth + 1)
                for _ in range(rng.randint(0, 3))
            }
        return [self.random_tree(rng, depth + 1) for _ in range(rng.randint(0, 3))]

    def test_merge_matches_oracle_on_small_trees(self):
        rng = random.Random(20261001)
        for _ in range(500):
            base = self.random_tree(rng, 0)
            ours = self.random_tree(rng, 0)
            theirs = self.random_tree(rng, 0)
            conflicts = []
            merged = merge3(base, ours, theirs, conflicts=conflicts)
            expected_merged, expected_conflicts = oracle(base, ours, theirs)
            self.assertEqual(merged, expected_merged)
            self.assertEqual(set(conflicts), expected_conflicts)
            self.assertEqual(
                len(conflicts), len(expected_conflicts),
                "conflict paths must be unique",
            )


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def run_merge(self, base, ours, theirs, extra=()):
        b = write_json(self.dir, "base.json", base)
        o = write_json(self.dir, "ours.json", ours)
        t = write_json(self.dir, "theirs.json", theirs)
        out = os.path.join(self.dir, "result.json")
        proc = run_cli(b, o, t, "-o", out, *extra)
        return proc, out

    def test_clean_merge_exit0_and_outputs(self):
        proc, out = self.run_merge(
            {"a": {"x": 1}, "l": [1, 2]},
            {"a": {"x": 2}, "l": [1, 2, 3]},
            {"a": {"x": 1}, "l": [1, 20]},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        expected = {"a": {"x": 2}, "l": [1, 20, 3]}
        self.assertEqual(json.loads(proc.stdout), expected)
        self.assertEqual(json.loads(proc.stderr), [])
        with open(out, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), expected)

    def test_conflict_exit1_and_pointer_on_stderr(self):
        proc, out = self.run_merge(
            {"k": 1}, {"k": 2}, {"k": 3}
        )
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(json.loads(proc.stderr), ["/k"])
        self.assertEqual(json.loads(proc.stdout), {"k": 2})
        self.assertTrue(os.path.exists(out))

    def test_invalid_json_exit2_no_output(self):
        bad = os.path.join(self.dir, "bad.json")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        o = write_json(self.dir, "ours.json", {})
        t = write_json(self.dir, "theirs.json", {})
        out = os.path.join(self.dir, "result.json")
        proc = run_cli(bad, o, t, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))
        self.assertEqual(proc.stdout, "")

    def test_missing_input_file_exit2_no_output(self):
        o = write_json(self.dir, "ours.json", {})
        t = write_json(self.dir, "theirs.json", {})
        out = os.path.join(self.dir, "result.json")
        proc = run_cli(os.path.join(self.dir, "nope.json"), o, t, "-o", out)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out))

    def test_usage_error_exit2(self):
        proc = run_cli()
        self.assertEqual(proc.returncode, 2)

    def test_unwritable_output_exit2(self):
        b = write_json(self.dir, "base.json", {})
        o = write_json(self.dir, "ours.json", {})
        t = write_json(self.dir, "theirs.json", {})
        proc = run_cli(b, o, t, "-o", os.path.join(self.dir, "no", "dir", "r.json"))
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
