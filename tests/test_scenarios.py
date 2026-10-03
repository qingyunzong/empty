"""Scenario tests required by the specification."""
import copy
import random
import unittest

from filepatch import (
    ApplyError,
    CertificateError,
    Tree,
    apply_patch,
    build_patch,
    invert_patch,
    verify_patch,
)

from helpers import random_files


def op_kinds(patch):
    return [op["op"] for op in patch["ops"]]


class ThreePathCycleTest(unittest.TestCase):
    def test_cycle_uses_temp_and_applies(self):
        source = Tree({"a": ["1"], "b": ["2"], "c": ["3"]})
        target = Tree({"a": ["2"], "b": ["3"], "c": ["1"]})
        patch = build_patch(source, target)
        # Rotating three files is cheaper as a rename cycle (cost 3)
        # than as three in-place modifications (cost 6).
        self.assertEqual(patch["cost"], 3)
        temps = [
            op for op in patch["ops"]
            if op["op"] == "rename"
            and (op["src"].startswith("__filepatch_tmp_")
                 or op["dst"].startswith("__filepatch_tmp_"))
        ]
        self.assertTrue(temps, "expected a temporary name for the cycle")
        self.assertEqual(apply_patch(source, patch), target)
        verify_patch(source, target, patch)

    def test_temp_names_never_collide_with_input_paths(self):
        source = Tree({
            "__filepatch_tmp_0__": ["t"],
            "a": ["1"],
            "b": ["2"],
        })
        target = Tree({
            "__filepatch_tmp_0__": ["t"],
            "a": ["2"],
            "b": ["1"],
        })
        patch = build_patch(source, target)
        for op in patch["ops"]:
            if op["op"] == "rename":
                self.assertNotEqual(op["dst"], "__filepatch_tmp_0__")
        self.assertEqual(apply_patch(source, patch), target)


class CrossPathPairingTest(unittest.TestCase):
    def test_swap_beats_same_name_modify(self):
        # Same-name contents changed, but pairing across paths is cheaper:
        # two renames cost 1 + 1 = 2, two modifies cost 2 + 2 = 4.
        source = Tree({"f1": ["X"], "f2": ["Y"]})
        target = Tree({"f1": ["Y"], "f2": ["X"]})
        patch = build_patch(source, target)
        self.assertEqual(patch["cost"], 2)
        # The matching pairs f1->f2 and f2->f1 (executed via a temp name).
        from filepatch import solve

        result = solve(source.files, target.files)
        pairs = {pair for pair in result.assignments if None not in pair}
        self.assertIn(("f1", "f2"), pairs)
        self.assertIn(("f2", "f1"), pairs)
        self.assertNotIn("modify", op_kinds(patch))
        self.assertEqual(apply_patch(source, patch), target)

    def test_no_greedy_hash_pairing(self):
        # A greedy same-hash pairing would keep "b" (identical content)
        # in place; the optimum moves contents across all three paths.
        source = Tree({"a": ["1"], "b": ["2"], "c": ["3"]})
        target = Tree({"a": ["2"], "b": ["3"], "c": ["1"]})
        patch = build_patch(source, target)
        self.assertEqual(patch["cost"], 3)
        self.assertNotIn("modify", op_kinds(patch))


class DuplicateContentTest(unittest.TestCase):
    def test_duplicate_contents(self):
        source = Tree({"a": ["same"], "b": ["same"], "c": ["uniq"]})
        target = Tree({"a": ["same"], "d": ["same"], "c": ["uniq", "x"]})
        patch = build_patch(source, target)
        verify_patch(source, target, patch)
        self.assertEqual(apply_patch(source, patch), target)

    def test_duplicate_contents_all_renamed(self):
        source = Tree({"a": ["same"], "b": ["same"]})
        target = Tree({"c": ["same"], "d": ["same"]})
        patch = build_patch(source, target)
        # Two renames (cost 1 + 1) beat delete+add (2 + 2 per file).
        self.assertEqual(patch["cost"], 2)
        self.assertEqual(apply_patch(source, patch), target)


class PrefixConflictTest(unittest.TestCase):
    def test_file_becomes_directory(self):
        source = Tree({"a": ["x"], "keep": ["k"]})
        target = Tree({"a/b": ["x"], "keep": ["k"]})
        patch = build_patch(source, target)
        self.assertEqual(apply_patch(source, patch), target)
        verify_patch(source, target, patch)

    def test_directory_becomes_file(self):
        source = Tree({"a/b": ["x"], "keep": ["k"]})
        target = Tree({"a": ["x"], "keep": ["k"]})
        patch = build_patch(source, target)
        self.assertEqual(apply_patch(source, patch), target)

    def test_swap_file_and_directory(self):
        source = Tree({"a": ["1"], "b/c": ["2"]})
        target = Tree({"a/c": ["1"], "b": ["2"]})
        patch = build_patch(source, target)
        self.assertEqual(apply_patch(source, patch), target)
        verify_patch(source, target, patch)


class TamperedCertificateTest(unittest.TestCase):
    def setUp(self):
        self.source = Tree({"a": ["1"], "b": ["2"]})
        self.target = Tree({"b": ["1"], "c": ["2", "x"]})
        self.patch = build_patch(self.source, self.target)

    def test_valid(self):
        self.assertTrue(verify_patch(self.source, self.target, self.patch))

    def test_tampered_potentials(self):
        patch = copy.deepcopy(self.patch)
        patch["certificate"]["row_potentials"][0] += 1
        with self.assertRaises(CertificateError):
            verify_patch(self.source, self.target, patch)

    def test_tampered_cost(self):
        patch = copy.deepcopy(self.patch)
        patch["certificate"]["cost"] += 1
        with self.assertRaises(CertificateError):
            verify_patch(self.source, self.target, patch)

    def test_tampered_ops_do_not_reach_target(self):
        patch = copy.deepcopy(self.patch)
        for op in patch["ops"]:
            if op["op"] == "modify":
                op["lines"] = ["forged"]
        with self.assertRaises(ApplyError):
            apply_patch(self.source, patch)


class AtomicApplyTest(unittest.TestCase):
    def test_failed_fingerprint_leaves_tree_untouched(self):
        source = Tree({"a": ["1"], "b": ["2"]})
        target = Tree({"a": ["9"], "b": ["2"]})
        patch = build_patch(source, target)
        wrong = Tree({"a": ["different"], "b": ["2"]})
        before = {p: list(l) for p, l in wrong.files.items()}
        with self.assertRaises(ApplyError):
            apply_patch(wrong, patch)
        self.assertEqual(wrong.files, before)

    def test_failed_midway_op_leaves_tree_untouched(self):
        source = Tree({"a": ["1"], "b": ["2"]})
        target = Tree({"a": ["1", "x"], "b": ["2", "y"]})
        patch = build_patch(source, target)
        broken = copy.deepcopy(patch)
        broken["ops"][-1]["src_sha256"] = "0" * 64
        before = {p: list(l) for p, l in source.files.items()}
        with self.assertRaises(ApplyError):
            apply_patch(source, broken)
        self.assertEqual(source.files, before)


class RoundTripTest(unittest.TestCase):
    def test_apply_then_reverse_restores_original(self):
        rng = random.Random(4242)
        for i in range(30):
            source_files = random_files(rng, rng.randint(0, 6))
            target_files = random_files(rng, rng.randint(0, 6))
            source, target = Tree(source_files), Tree(target_files)
            patch = build_patch(source, target)
            verify_patch(source, target, patch)
            with self.subTest(i=i, source=source_files, target=target_files):
                applied = apply_patch(source, patch)
                self.assertEqual(applied, target)
                restored = apply_patch(applied, invert_patch(patch))
                self.assertEqual(restored, source)


if __name__ == "__main__":
    unittest.main()
