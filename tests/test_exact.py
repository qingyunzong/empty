import unittest
from fractions import Fraction

from rknni.exact import (
    bbox_from_points,
    bbox_mindist,
    dist2,
    idkey,
    parse_vector,
    point_in_bbox,
    to_fraction,
)


class TestFractionParsing(unittest.TestCase):
    def test_parse_forms(self):
        self.assertEqual(to_fraction(3), Fraction(3))
        self.assertEqual(to_fraction("3/2"), Fraction(3, 2))
        self.assertEqual(to_fraction("1.5"), Fraction(3, 2))
        self.assertEqual(to_fraction("-7"), Fraction(-7))
        self.assertEqual(to_fraction([3, 2]), Fraction(3, 2))
        self.assertEqual(to_fraction(Fraction(5, 9)), Fraction(5, 9))

    def test_rejects_inexact_input(self):
        for bad in (1.5, True, None, "abc", [1, 2, 3], ["a", 2]):
            with self.assertRaises((TypeError, ValueError)):
                to_fraction(bad)

    def test_dist2_exact(self):
        a = parse_vector(["1/3", "2/7"])
        b = parse_vector(["5/6", "-1/2"])
        expected = (Fraction(1, 3) - Fraction(5, 6)) ** 2 + (
            Fraction(2, 7) - Fraction(-1, 2)
        ) ** 2
        self.assertEqual(dist2(a, b), expected)

    def test_huge_values_beyond_float_precision(self):
        base = 10**18
        d1 = dist2(parse_vector([base]), parse_vector([0]))
        d2 = dist2(parse_vector([base + 1]), parse_vector([0]))
        self.assertNotEqual(d1, d2)
        self.assertEqual(d2 - d1, 2 * base + 1)
        # The whole point of exact arithmetic: floats cannot tell these apart.
        self.assertEqual(float(d1), float(d2))

    def test_idkey_total_order(self):
        self.assertLess(idkey(3), idkey(10))
        self.assertLess(idkey(10), idkey("a"))
        self.assertLess(idkey("a"), idkey("b"))


class TestBBox(unittest.TestCase):
    def test_mindist_inside_is_zero(self):
        bbox = bbox_from_points([parse_vector([0, 0]), parse_vector([4, 4])])
        self.assertEqual(bbox_mindist(bbox, parse_vector([2, 2])), 0)

    def test_mindist_outside(self):
        bbox = bbox_from_points([parse_vector([0, 0]), parse_vector([2, 2])])
        # query (5, -1): dx = 3, dy = 1 -> 10
        self.assertEqual(bbox_mindist(bbox, parse_vector([5, -1])), 10)

    def test_mindist_rational(self):
        bbox = bbox_from_points([parse_vector(["1/2"]), parse_vector(["3/4"])])
        self.assertEqual(
            bbox_mindist(bbox, parse_vector(["2"])), Fraction(5, 4) ** 2
        )

    def test_point_in_bbox(self):
        bbox = bbox_from_points([parse_vector([0]), parse_vector([2])])
        self.assertTrue(point_in_bbox(bbox, parse_vector([2])))
        self.assertFalse(point_in_bbox(bbox, parse_vector([3])))


if __name__ == "__main__":
    unittest.main()
