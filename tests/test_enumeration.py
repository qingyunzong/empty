"""Cross-check the optimiser against full enumeration of all legal
matchings for trees with at most 7 files in total, including the
lexicographic tie-breaking rule."""
import random
import unittest

from patchtool import FileTree, apply_patch, brute_force_best, diff_trees, op_key
from patchtool.certificate import verify_certificate

PATH_POOL = ["a", "b", "c", "d", "e", "a/x", "a/y", "b/x", "d/e"]
CONTENT_POOL = [
    (),
    ("x",),
    ("y",),
    ("x", "y"),
    ("hello", "world"),
    ("same",),
    ("same",),  # duplicated on purpose: duplicate contents must occur
]


def random_tree(rng, max_files):
    paths = rng.sample(PATH_POOL, rng.randint(0, max_files))
    files = {}
    for p in paths:
        files[p] = rng.choice(CONTENT_POOL)
        # force parent dirs of nested paths to be representable: ensure no
        # file sits below another file
    files = {p: ls for p, ls in files.items()
             if all(parent not in files for parent in
                    ["/".join(p.split("/")[:i]) for i in range(1, len(p.split("/")))])}
    dirs = set()
    if rng.random() < 0.3:
        cand = rng.choice(PATH_POOL)
        if cand not in files and all(
                "/".join(cand.split("/")[:i]) not in files
                for i in range(1, len(cand.split("/")))):
            if not any(f.startswith(cand + "/") for f in files):
                dirs.add(cand)
    return FileTree(files, dirs)


class TestEnumeration(unittest.TestCase):
    def test_optimal_cost_and_tie_break_up_to_7_files(self):
        rng = random.Random(7)
        trials = 0
        while trials < 250:
            old = random_tree(rng, 4)
            new = random_tree(rng, 4)
            if len(old.files) + len(new.files) > 7:
                continue
            trials += 1
            patch = diff_trees(old, new)
            got_ops = [op_key(o) for o in patch["ops"]]
            best_cost, best_ops = brute_force_best(old, new)
            self.assertEqual(patch["cost"], best_cost,
                             f"cost mismatch for {old!r} -> {new!r}")
            self.assertEqual(got_ops, best_ops,
                             f"tie-break mismatch for {old!r} -> {new!r}")
            # the patch must actually transform old into new
            self.assertEqual(apply_patch(old, patch), new)
            # and its certificate must verify without the optimiser
            verify_certificate(old, new, patch["certificate"],
                               expected_ops=got_ops)

    def test_exactly_7_files(self):
        rng = random.Random(77)
        for _ in range(25):
            old = random_tree(rng, 7)
            new = random_tree(rng, 7)
            while len(old.files) + len(new.files) > 7:
                if len(old.files) >= len(new.files):
                    old = FileTree(dict(list(old.files.items())[:-1]))
                else:
                    new = FileTree(dict(list(new.files.items())[:-1]))
            patch = diff_trees(old, new)
            best_cost, best_ops = brute_force_best(old, new)
            self.assertEqual(patch["cost"], best_cost)
            self.assertEqual([op_key(o) for o in patch["ops"]], best_ops)


if __name__ == "__main__":
    unittest.main()
