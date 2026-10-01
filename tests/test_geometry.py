import unittest
from fractions import Fraction

from arrangement.geometry import (
    angle_cmp,
    line_intersection,
    line_key,
    make_point,
    norm_dir,
    on_segment,
    orient,
    to_fraction,
)


class TestExactNumbers(unittest.TestCase):
    def test_to_fraction_forms(self):
        self.assertEqual(to_fraction(3), Fraction(3))
        self.assertEqual(to_fraction("3/4"), Fraction(3, 4))
        self.assertEqual(to_fraction("0.1"), Fraction(1, 10))
        self.assertEqual(to_fraction(0.1), Fraction(1, 10))
        self.assertEqual(to_fraction(Fraction(7, 9)), Fraction(7, 9))

    def test_to_fraction_rejects_garbage(self):
        for bad in ("abc", [1], None, True):
            with self.assertRaises((TypeError, ValueError)):
                to_fraction(bad)


class TestPredicates(unittest.TestCase):
    def test_orient_exact_with_huge_rationals(self):
        a = (Fraction(0), Fraction(0))
        b = (Fraction(10**18), Fraction(1))
        c = (Fraction(10**18), Fraction(2))
        self.assertEqual(orient(a, b, c), 1)
        self.assertEqual(orient(a, c, b), -1)
        self.assertEqual(orient(a, b, b), 0)

    def test_line_key_normalization(self):
        p = (Fraction(1, 3), Fraction(1, 2))
        q = (Fraction(5, 3), Fraction(3, 2))
        self.assertEqual(line_key(p, q), line_key(q, p))
        r = (Fraction(13, 3), Fraction(7, 2))
        self.assertEqual(line_key(p, q), line_key(p, r))
        self.assertNotEqual(line_key(p, q), line_key(p, (Fraction(0), Fraction(0))))

    def test_norm_dir_canonical(self):
        p = (Fraction(0), Fraction(0))
        self.assertEqual(norm_dir(p, (Fraction(2), Fraction(2))), (1, 1))
        self.assertEqual(norm_dir((Fraction(2), Fraction(2)), p), (1, 1))
        self.assertEqual(norm_dir(p, (Fraction(0), Fraction(-3))), (0, 1))

    def test_on_segment(self):
        a = make_point((0, 0))
        b = make_point((4, 4))
        self.assertTrue(on_segment(make_point((2, 2)), a, b))
        self.assertTrue(on_segment(a, a, b))
        self.assertFalse(on_segment(make_point((5, 5)), a, b))
        self.assertFalse(on_segment(make_point((2, 1)), a, b))

    def test_line_intersection_exact_thirds(self):
        a = make_point((0, 0))
        b = make_point((1, 1))
        c = make_point((0, "1/3"))
        d = make_point((1, 0))
        pt = line_intersection(a, b, c, d)
        self.assertEqual(pt, (Fraction(1, 4), Fraction(1, 4)))
        self.assertIsNone(line_intersection(a, b, make_point((0, 1)), make_point((1, 2))))


class TestAngleCmp(unittest.TestCase):
    def test_full_circle_order(self):
        dirs = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
        dirs = [(Fraction(x), Fraction(y)) for x, y in dirs]
        for i in range(len(dirs)):
            for j in range(len(dirs)):
                expected = (i > j) - (i < j)
                self.assertEqual(angle_cmp(dirs[i], dirs[j]), expected)

    def test_exactness_beyond_float_resolution(self):
        # slopes 1/10^30 vs (10^30+1)/10^60 : indistinguishable in float64
        d1 = (Fraction(10**30), Fraction(1))
        d2 = (Fraction(10**60), Fraction(10**30 + 1))
        self.assertEqual(angle_cmp(d1, d2), -1)
        self.assertEqual(angle_cmp(d2, d1), 1)
        self.assertEqual(angle_cmp(d1, d1), 0)


if __name__ == "__main__":
    unittest.main()
