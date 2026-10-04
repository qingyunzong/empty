import unittest

from pathpolicy.normalize import PathError, normalize_path, path_segments


class NormalizeTests(unittest.TestCase):
    def test_plain_path_unchanged(self):
        self.assertEqual(normalize_path("a/b/c"), "a/b/c")

    def test_consecutive_separators_collapse(self):
        self.assertEqual(normalize_path("a//b///c"), "a/b/c")

    def test_dot_segments_removed(self):
        self.assertEqual(normalize_path("a/./b/./c"), "a/b/c")

    def test_dotdot_resolved_within_root(self):
        self.assertEqual(normalize_path("a/b/../c"), "a/c")
        self.assertEqual(normalize_path("a/b/../../c"), "c")

    def test_dotdot_to_root(self):
        self.assertEqual(normalize_path("a/.."), "")

    def test_escape_root_rejected(self):
        for bad in ("..", "../a", "a/../../b", "a/b/../../../c", "../../.."):
            with self.assertRaises(PathError, msg=bad):
                normalize_path(bad)

    def test_empty_root_path(self):
        for path in ("", "/", ".", "//", "/./", "a/.."):
            self.assertEqual(normalize_path(path), "", msg=path)

    def test_distinct_inputs_normalize_to_same_path(self):
        self.assertEqual(normalize_path("a//./b/"), normalize_path("a/b"))
        self.assertEqual(normalize_path("./a/b/../b//"), "a/b")

    def test_segments_of_root(self):
        self.assertEqual(path_segments(""), [])
        self.assertEqual(path_segments("a/b"), ["a", "b"])

    def test_non_string_rejected(self):
        with self.assertRaises(PathError):
            normalize_path(None)


if __name__ == "__main__":
    unittest.main()
