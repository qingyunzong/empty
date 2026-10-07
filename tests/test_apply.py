import random
import unittest

from patchtool import FileTree, apply_patch, diff_trees
from patchtool.apply import ApplyError


def random_tree(rng, paths, contents, max_files):
    n = rng.randint(0, max_files)
    chosen = rng.sample(paths, min(n, len(paths)))
    files = {}
    for p in chosen:
        files[p] = tuple(rng.choice(contents))
    files = {p: ls for p, ls in files.items()
             if all("/".join(p.split("/")[:i]) not in files
                    for i in range(1, len(p.split("/"))))}
    return FileTree(files)


PATHS = ["a", "b", "c", "d", "e", "f", "g"]
CONTENTS = [(), ("x",), ("y",), ("x", "y"), ("hello",), ("a", "b", "c")]


class TestAtomicApply(unittest.TestCase):
    def test_fingerprint_failure_leaves_tree_unchanged(self):
        old = FileTree({"a": ("x",), "b": ("y",)})
        new = FileTree({"a": ("y",), "b": ("x",), "c": ("z",)})
        patch = diff_trees(old, new)
        before = old.to_dict()

        tampered = FileTree({"a": ("CHANGED",), "b": ("y",)})
        with self.assertRaises(ApplyError):
            apply_patch(tampered, patch)
        self.assertEqual(tampered.to_dict(),
                         FileTree({"a": ("CHANGED",), "b": ("y",)}).to_dict())

        missing = FileTree({"a": ("x",)})
        with self.assertRaises(ApplyError):
            apply_patch(missing, patch)

        extra = FileTree({"a": ("x",), "b": ("y",), "c": ("z",)})
        with self.assertRaises(ApplyError):
            apply_patch(extra, patch)

        # the original tree is untouched and the patch still applies cleanly
        self.assertEqual(old.to_dict(), before)
        self.assertEqual(apply_patch(old, patch), new)

    def test_apply_is_pure(self):
        old = FileTree({"a": ("1",), "d/e": ("2",)}, {"d"})
        new = FileTree({"a": ("1", "2"), "f": ("2",)})
        patch = diff_trees(old, new)
        snapshot = old.to_dict()
        apply_patch(old, patch)
        self.assertEqual(old.to_dict(), snapshot)


class TestRoundTripRestore(unittest.TestCase):
    def test_apply_then_reverse_restores_original(self):
        rng = random.Random(1234)
        for _ in range(100):
            old = random_tree(rng, PATHS, CONTENTS, 4)
            new = random_tree(rng, PATHS, CONTENTS, 4)
            forward = diff_trees(old, new)
            reached = apply_patch(old, forward)
            self.assertEqual(reached, new)
            backward = diff_trees(reached, old)
            restored = apply_patch(reached, backward)
            self.assertEqual(restored, old)

    def test_known_example_round_trip(self):
        old = FileTree({"a": ("alpha",), "b": ("beta",), "c": ("gamma",)})
        new = FileTree({"a": ("gamma",), "b": ("alpha",), "c": ("beta",)})
        forward = diff_trees(old, new)
        reached = apply_patch(old, forward)
        self.assertEqual(reached, new)
        backward = diff_trees(reached, old)
        restored = apply_patch(reached, backward)
        self.assertEqual(restored, old)


if __name__ == "__main__":
    unittest.main()
