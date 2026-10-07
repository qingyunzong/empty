import unittest

from pathpolicy import normalize_path, path_segments, PathEscapeError, PathError


class NormalizeTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(normalize_path("a/b"), "/a/b")
        self.assertEqual(normalize_path("/a/b"), "/a/b")
        self.assertEqual(normalize_path("/a/b/"), "/a/b")

    def test_consecutive_separators(self):
        self.assertEqual(normalize_path("a//b"), "/a/b")
        self.assertEqual(normalize_path("//a///b//"), "/a/b")

    def test_dot_segments(self):
        self.assertEqual(normalize_path("a/./b"), "/a/b")
        self.assertEqual(normalize_path("./a"), "/a")

    def test_dotdot_resolution(self):
        self.assertEqual(normalize_path("a/../b"), "/b")
        self.assertEqual(normalize_path("a/b/../../c"), "/c")

    def test_empty_root(self):
        self.assertEqual(normalize_path(""), "/")
        self.assertEqual(normalize_path("/"), "/")
        self.assertEqual(normalize_path("."), "/")
        self.assertEqual(normalize_path("//"), "/")

    def test_escape_rejected(self):
        for bad in ("..", "/..", "../a", "a/../..", "a/../../b", "a/./../../x"):
            with self.assertRaises(PathEscapeError, msg=bad):
                normalize_path(bad)

    def test_non_string_rejected(self):
        with self.assertRaises(PathError):
            normalize_path(None)

    def test_two_inputs_same_path(self):
        forms = ["a/b", "/a/b", "a//b", "a/./b", "/a//b/", "x/../a/b", "a/b/."]
        self.assertEqual(len({normalize_path(f) for f in forms}), 1)

    def test_segments(self):
        self.assertEqual(path_segments("/"), ())
        self.assertEqual(path_segments("a//b"), ("a", "b"))


if __name__ == "__main__":
    unittest.main()
