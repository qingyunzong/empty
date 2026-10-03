"""Query behaviour: directional extremes, tangents, tie-breaking rules."""

import unittest

from rational_hull import DynamicConvexHull


def square():
    h = DynamicConvexHull()
    h.insert("a", 0, 0)
    h.insert("b", 2, 0)
    h.insert("c", 2, 2)
    h.insert("d", 0, 2)
    return h


class TestExtreme(unittest.TestCase):
    def test_unique_extreme(self):
        h = square()
        self.assertEqual(h.extreme(1, 1).id, "c")
        self.assertEqual(h.extreme(-1, -1).id, "a")
        self.assertEqual(h.extreme(-2, 1).id, "d")

    def test_tie_breaks_by_perpendicular_then_id(self):
        h = square()
        # Direction (1,0): edge b-c ties; d_perp=(0,1) picks the top one.
        self.assertEqual(h.extreme(1, 0).id, "c")
        # Direction (0,-1): edge a-b ties; d_perp=(1,0) picks the right one.
        self.assertEqual(h.extreme(0, -1).id, "b")
        # Direction (-1,0): edge a-d ties; d_perp=(0,-1) picks the bottom.
        self.assertEqual(h.extreme(-1, 0).id, "a")
        # Direction (0,1): edge c-d ties; d_perp=(-1,0) picks the left.
        self.assertEqual(h.extreme(0, 1).id, "d")

    def test_tie_breaks_by_id_at_same_coordinate(self):
        h = DynamicConvexHull()
        h.insert("z9", 5, 5)
        h.insert("a0", 5, 5)
        h.insert("q", 0, 0)
        self.assertEqual(h.extreme(1, 1).id, "a0")

    def test_zero_direction_rejected(self):
        h = square()
        with self.assertRaises(ValueError):
            h.extreme(0, 0)

    def test_fractional_direction(self):
        h = square()
        self.assertEqual(h.extreme("1/2", "3/4").id, "c")


class TestTangent(unittest.TestCase):
    def test_basic_tangents(self):
        h = square()
        left, right = h.tangent(5, 1)
        self.assertEqual((left.id, right.id), ("c", "b"))

    def test_tangent_tie_picks_nearest_vertex(self):
        h = square()
        # q is collinear with the bottom edge a-b; the tangent touches at
        # the nearest vertex b, not at a.
        left, right = h.tangent(5, 0)
        self.assertEqual(right.id, "b")
        self.assertEqual(left.id, "c")

    def test_tangent_from_axis(self):
        h = square()
        left, right = h.tangent(1, 5)
        self.assertEqual((left.id, right.id), ("d", "c"))

    def test_tangent_requires_exterior_point(self):
        h = square()
        with self.assertRaises(ValueError):
            h.tangent(1, 1)  # strictly inside
        with self.assertRaises(ValueError):
            h.tangent(0, 1)  # on the boundary

    def test_tangent_requires_nondegenerate_hull(self):
        h = DynamicConvexHull()
        h.insert("a", 0, 0)
        h.insert("b", 1, 1)
        with self.assertRaises(ValueError):
            h.tangent(5, 0)


class TestContainsPoint(unittest.TestCase):
    def test_classification(self):
        h = square()
        self.assertEqual(h.contains_point(1, 1), "inside")
        self.assertEqual(h.contains_point(0, 1), "boundary")
        self.assertEqual(h.contains_point(2, 2), "boundary")
        self.assertEqual(h.contains_point(3, 1), "outside")
        self.assertEqual(h.contains_point("1/2", "3/2"), "inside")


if __name__ == "__main__":
    unittest.main()
