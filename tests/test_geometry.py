import unittest
from fractions import Fraction

from knnindex.geometry import box_dist2, box_union, dist2, point_box, to_point


class TestExactGeometry(unittest.TestCase):
    def test_squared_distance_is_exact_rational(self):
        a = to_point(["1/3", "2/5"])
        b = to_point(["7/11", "-3/2"])
        d = dist2(a, b)
        self.assertIsInstance(d, Fraction)
        self.assertEqual(d, (Fraction(1, 3) - Fraction(7, 11)) ** 2
                         + (Fraction(2, 5) - Fraction(-3, 2)) ** 2)

    def test_huge_coordinates_no_float_error(self):
        big = 10**30
        a = to_point([big, 0])
        b = to_point([big + 1, 0])
        self.assertEqual(dist2(a, b), Fraction(1))
        # a float computation would lose this difference entirely
        self.assertNotEqual(float(big), float(big + 1) - 1 + float(big))

    def test_box_dist2_inside_is_zero(self):
        box = ((Fraction(0), Fraction(0)), (Fraction(2), Fraction(2)))
        self.assertEqual(box_dist2(box, (Fraction(1), Fraction(1))), 0)

    def test_box_dist2_outside_is_exact(self):
        box = ((Fraction(0), Fraction(0)), (Fraction(2), Fraction(2)))
        q = (Fraction(4), Fraction(-3))
        self.assertEqual(box_dist2(box, q), Fraction(4 + 9))

    def test_box_dist2_fractional(self):
        box = point_box(to_point(["1/2", "1/3"]))
        q = to_point(["0", "0"])
        self.assertEqual(box_dist2(box, q), Fraction(1, 4) + Fraction(1, 9))

    def test_box_union_contains_both(self):
        a = point_box(to_point([0, 0]))
        b = point_box(to_point([3, -1]))
        u = box_union(a, b)
        self.assertEqual(u[0], (Fraction(0), Fraction(-1)))
        self.assertEqual(u[1], (Fraction(3), Fraction(0)))


if __name__ == "__main__":
    unittest.main()
