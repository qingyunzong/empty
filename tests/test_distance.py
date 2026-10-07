import unittest

from patchtool.distance import (content_distance, edit_distance,
                                path_distance, script_length)
from patchtool.model import byte_count


class TestDistance(unittest.TestCase):
    def test_levenshtein(self):
        self.assertEqual(edit_distance("kitten", "sitting"), 3)
        self.assertEqual(edit_distance("", "abc"), 3)
        self.assertEqual(edit_distance("abc", "abc"), 0)
        self.assertEqual(edit_distance("abc", ""), 3)

    def test_script_length_is_insertions_plus_deletions(self):
        self.assertEqual(script_length(["a", "b", "c"], ["a", "c"]), 1)
        self.assertEqual(script_length(["a"], ["b"]), 2)  # del + ins
        self.assertEqual(script_length([], ["x", "y"]), 2)
        self.assertEqual(script_length(["x"], ["x"]), 0)

    def test_content_and_path_distance(self):
        self.assertEqual(path_distance("a/b", "a/c"), 1)
        self.assertEqual(content_distance(["x"], ["x", "y"]), 1)

    def test_byte_count(self):
        self.assertEqual(byte_count([]), 0)
        self.assertEqual(byte_count(["ab", "c"]), 5)  # "ab\n" + "c\n"
        self.assertEqual(byte_count(["é"]), 3)        # 2-byte char + "\n"

    def test_costs_are_non_negative_integers(self):
        for value in (edit_distance("a", "b"), script_length(["a"], ["b"]),
                      byte_count(["x"])):
            self.assertIsInstance(value, int)
            self.assertGreaterEqual(value, 0)


if __name__ == "__main__":
    unittest.main()
