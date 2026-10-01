import unittest
from fractions import Fraction
from functools import cmp_to_key

from arrangement.geom import (
    cmp_angle,
    line_key,
    on_segment,
    orient,
    proper_intersection,
    to_frac,
    to_point,
)

F = Fraction


class TestExactPredicates(unittest.TestCase):
    def test_orient(self):
        a, b, c = (F(0), F(0)), (F(4), F(0)), (F(0), F(3))
        self.assertEqual(orient(a, b, c), 1)
        self.assertEqual(orient(a, c, b), -1)
        self.assertEqual(orient(a, b, (F(2), F(0))), 0)

    def test_to_frac_rejects_float(self):
        self.assertEqual(to_frac(3), F(3))
        self.assertEqual(to_frac("3/2"), F(3, 2))
        self.assertEqual(to_frac(F(7, 5)), F(7, 5))
        with self.assertRaises(ValueError):
            to_frac(1.5)
        with self.assertRaises(ValueError):
            to_frac("abc")

    def test_to_point(self):
        self.assertEqual(to_point(["1/2", 2]), (F(1, 2), F(2)))
        with self.assertRaises(ValueError):
            to_point([1])
        with self.assertRaises(ValueError):
            to_point([1, "x"])

    def test_cmp_angle_full_circle(self):
        # Directions around the compass, already in CCW order from +x.
        dirs = [
            (F(1), F(0)),
            (F(1), F(1)),
            (F(0), F(1)),
            (F(-1), F(1)),
            (F(-1), F(0)),
            (F(-1), F(-1)),
            (F(0), F(-1)),
            (F(1), F(-1)),
        ]
        for i in range(len(dirs)):
            for j in range(len(dirs)):
                expect = (i > j) - (i < j)
                self.assertEqual(cmp_angle(dirs[i], dirs[j]), expect,
                                 (dirs[i], dirs[j]))
        # Sorting a shuffled list reproduces the circular order.
        shuffled = [dirs[5], dirs[0], dirs[7], dirs[2]]
        shuffled.sort(key=cmp_to_key(cmp_angle))
        self.assertEqual(shuffled, [dirs[0], dirs[2], dirs[5], dirs[7]])
        # Parallel same-direction vectors compare equal.
        self.assertEqual(cmp_angle((F(2), F(2)), (F(1), F(1))), 0)

    def test_line_key_normalization(self):
        k1 = line_key((F(0), F(0)), (F(2), F(2)))
        k2 = line_key((F(3), F(3)), (F(-1), F(-1)))
        k3 = line_key((F(0), F(0)), (F(0), F(5)))
        k4 = line_key((F(1), F(0)), (F(1), F(9)))
        self.assertEqual(k1, k2)
        self.assertNotEqual(k1, k3)
        self.assertNotEqual(k3, k4)

    def test_proper_intersection_exact(self):
        p = proper_intersection(
            (F(0), F(0)), (F(3), F(3)),
            (F(0), F(3)), (F(3), F(0)),
        )
        self.assertEqual(p, (F(3, 2), F(3, 2)))
        # Thirds stay exact -- no float rounding.
        p = proper_intersection(
            (F(0), F(0)), (F(1), F(1)),
            (F(0), F(1)), (F(1), F(0)),
        )
        self.assertEqual(p, (F(1, 2), F(1, 2)))
        p = proper_intersection(
            (F(0), F(0)), (F(3), F(1)),
            (F(0), F(1)), (F(3), F(0)),
        )
        self.assertEqual(p, (F(3, 2), F(1, 2)))
        # Disjoint segments.
        self.assertIsNone(proper_intersection(
            (F(0), F(0)), (F(1), F(0)),
            (F(0), F(1)), (F(1), F(1)),
        ))
        # Parallel.
        self.assertIsNone(proper_intersection(
            (F(0), F(0)), (F(1), F(1)),
            (F(0), F(1)), (F(1), F(2)),
        ))

    def test_on_segment(self):
        a, b = (F(0), F(0)), (F(4), F(2))
        self.assertTrue(on_segment((F(2), F(1)), a, b))
        self.assertTrue(on_segment(a, a, b))
        self.assertFalse(on_segment((F(2), F(2)), a, b))
        self.assertFalse(on_segment((F(5), F(5, 2)), a, b))


if __name__ == "__main__":
    unittest.main()
