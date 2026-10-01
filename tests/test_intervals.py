import unittest

from symdfa.intervals import (
    IntervalError,
    complement,
    intersect,
    is_subset,
    normalize,
    subtract,
    union,
)


class TestIntervals(unittest.TestCase):
    def test_normalize_sorts_and_validates(self):
        self.assertEqual(normalize([(5, 9), (0, 3)], 16), ((0, 3), (5, 9)))

    def test_overlap_rejected(self):
        with self.assertRaises(IntervalError):
            normalize([(0, 5), (4, 7)], 16)

    def test_adjacent_rejected(self):
        # touching intervals must have been merged by the caller
        with self.assertRaises(IntervalError):
            normalize([(0, 5), (6, 7)], 16)

    def test_out_of_range_rejected(self):
        with self.assertRaises(IntervalError):
            normalize([(0, 16)], 16)
        with self.assertRaises(IntervalError):
            normalize([(-1, 3)], 16)

    def test_empty_interval_rejected(self):
        with self.assertRaises(IntervalError):
            normalize([(4, 2)], 16)

    def test_algebra(self):
        a = ((0, 3), (6, 9))
        b = ((2, 6),)
        self.assertEqual(union(a, b), ((0, 9),))
        self.assertEqual(intersect(a, b), ((2, 3), (6, 6)))
        self.assertEqual(subtract(a, b), ((0, 1), (7, 9)))
        self.assertEqual(complement(a, 12), ((4, 5), (10, 11)))
        self.assertTrue(is_subset(((1, 2),), a))
        self.assertFalse(is_subset(((1, 4),), a))


if __name__ == "__main__":
    unittest.main()
