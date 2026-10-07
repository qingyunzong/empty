import unittest

from patchtool import FileTree, apply_patch, diff_trees, op_key
from patchtool.certificate import verify_certificate


def make(tree_spec):
    files = {p: tuple(ls) for p, (ls, *_) in tree_spec.items() if ls is not None}
    dirs = {p for p, (ls, *_) in tree_spec.items() if ls is None}
    return FileTree(files, dirs)


class TestRenameCycle(unittest.TestCase):
    def test_three_path_cycle_uses_temp_name(self):
        old = FileTree({"a": ("alpha",), "b": ("beta",), "c": ("gamma",)})
        new = FileTree({"a": ("gamma",), "b": ("alpha",), "c": ("beta",)})
        patch = diff_trees(old, new)
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("rename", "a", "b"),
                          ("rename", "b", "c"),
                          ("rename", "c", "a")])
        self.assertEqual(patch["cost"], 3)
        # the cycle must be broken with a temporary name that collides with
        # no input path
        temps = {s["dst"] for s in patch["plan"]
                 if s["step"] == "rename" and s["dst"].startswith(".patch-tmp-")}
        self.assertEqual(len(temps), 1)
        self.assertFalse(temps & (set(old.files) | set(new.files)))
        self.assertEqual(apply_patch(old, patch), new)
        verify_certificate(old, new, patch["certificate"],
                           expected_ops=[op_key(o) for o in patch["ops"]])

    def test_path_swap_two_cycle(self):
        old = FileTree({"a": ("x1", "x2"), "b": ("y1", "y2")})
        new = FileTree({"a": ("y1", "y2"), "b": ("x1", "x2")})
        patch = diff_trees(old, new)
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("rename", "a", "b"), ("rename", "b", "a")])
        self.assertEqual(patch["cost"], 2)  # cheaper than two modifies (8)
        self.assertEqual(apply_patch(old, patch), new)


class TestCrossPathPairing(unittest.TestCase):
    def test_cross_path_beats_same_name_modify(self):
        # Same-name content change would cost SES 4 + add/delete bytes 6+6;
        # pairing contents across paths costs 1 + 1.
        old = FileTree({"a": ("x1", "x2"), "b": ("y1", "y2")})
        new = FileTree({"a": ("y1", "y2"), "c": ("x1", "x2")})
        patch = diff_trees(old, new)
        self.assertEqual(patch["cost"], 2)
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("rename", "a", "c"), ("rename", "b", "a")])
        self.assertEqual(apply_patch(old, patch), new)

    def test_no_greedy_same_name_pairing(self):
        # A heuristic that keeps same-name (or same-hash) files paired would
        # modify "k" in place (cost 2) and rename "m"->"e" (cost 3); the
        # global optimum pairs contents across paths for a total of 2.
        old = FileTree({"k": ("same",), "m": ("other",)})
        new = FileTree({"k": ("other",), "e": ("same",)})
        patch = diff_trees(old, new)
        self.assertEqual(patch["cost"], 2)
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("rename", "k", "e"), ("rename", "m", "k")])
        self.assertEqual(apply_patch(old, patch), new)


class TestDuplicateContent(unittest.TestCase):
    def test_duplicate_content_tie_break(self):
        old = FileTree({"a": ("same",), "b": ("same",)})
        new = FileTree({"c": ("same",), "d": ("same",)})
        patch = diff_trees(old, new)
        # both pairings are optimal; lexicographic tie-break picks a->c, b->d
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("rename", "a", "c"), ("rename", "b", "d")])
        self.assertEqual(apply_patch(old, patch), new)

    def test_empty_files_zero_cost_ops(self):
        # Deleting and re-adding empty files costs 0, beating renames (2);
        # among the zero-cost matchings the canonical op sequence is unique.
        old = FileTree({"a": (), "b": ()})
        new = FileTree({"c": (), "d": ()})
        patch = diff_trees(old, new)
        self.assertEqual(patch["cost"], 0)
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("add", "c"), ("add", "d"),
                          ("delete", "a"), ("delete", "b")])
        self.assertEqual(apply_patch(old, patch), new)


class TestPathPrefixConflicts(unittest.TestCase):
    def test_file_becomes_directory(self):
        old = FileTree({"a": ("payload",)})
        new = FileTree({"a/b": ("payload",)})
        patch = diff_trees(old, new)
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("rename", "a", "a/b")])
        self.assertEqual(apply_patch(old, patch), new)

    def test_directory_becomes_file(self):
        old = FileTree({"a/b": ("payload",)}, {"a"})
        new = FileTree({"a": ("payload",)})
        patch = diff_trees(old, new)
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("rename", "a/b", "a")])
        self.assertEqual(apply_patch(old, patch), new)

    def test_rename_into_new_subdirectory(self):
        old = FileTree({"top": ("data",)})
        new = FileTree({"x/y/z": ("data",)})
        patch = diff_trees(old, new)
        self.assertEqual(apply_patch(old, patch), new)
        kinds = [s["step"] for s in patch["plan"]]
        self.assertEqual(kinds.count("mkdir"), 2)  # x, x/y

    def test_rename_mkdir_deadlock(self):
        # "b" must become a directory while its content moves to "b/x" and
        # "a"'s content moves onto "a" from "b": the renames a -> b/x and
        # b -> a deadlock with the mkdir of "b" unless a temporary name
        # is used for the blocking file.
        old = FileTree({"a": ("one",), "b": ("two",)})
        new = FileTree({"a": ("two",), "b/x": ("one",)})
        patch = diff_trees(old, new)
        self.assertEqual([op_key(o) for o in patch["ops"]],
                         [("rename", "a", "b/x"), ("rename", "b", "a")])
        self.assertEqual(apply_patch(old, patch), new)
        verify_certificate(old, new, patch["certificate"],
                           expected_ops=[op_key(o) for o in patch["ops"]])


if __name__ == "__main__":
    unittest.main()
