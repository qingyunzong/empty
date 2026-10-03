"""Core behaviour: degenerate sets, collinearity, duplicates, errors."""

import unittest
from fractions import Fraction

from rational_hull import DynamicConvexHull, VerificationError


def ids(hull):
    return [v.id for v in hull.hull().vertices]


def coords(hull):
    return [(v.x, v.y) for v in hull.hull().vertices]


class TestDegenerate(unittest.TestCase):
    def test_empty(self):
        h = DynamicConvexHull()
        self.assertEqual(len(h.hull().vertices), 0)
        self.assertEqual(len(h.hull().edges), 0)
        self.assertTrue(h.verify())
        self.assertEqual(h.contains_point(0, 0), "outside")
        with self.assertRaises(ValueError):
            h.extreme(1, 0)
        with self.assertRaises(ValueError):
            h.tangent(5, 5)

    def test_single_point(self):
        h = DynamicConvexHull()
        h.insert("a", "3/2", "-7/4")
        self.assertEqual(ids(h), ["a"])
        self.assertEqual(coords(h), [(Fraction(3, 2), Fraction(-7, 4))])
        self.assertTrue(h.verify())
        self.assertEqual(h.extreme(1, 1).id, "a")
        self.assertEqual(h.contains_point("3/2", "-7/4"), "boundary")
        self.assertEqual(h.contains_point(0, 0), "outside")

    def test_two_points(self):
        h = DynamicConvexHull()
        h.insert("a", 0, 0)
        h.insert("b", 3, 1)
        self.assertEqual(ids(h), ["a", "b"])
        self.assertEqual(len(h.hull().edges), 2)
        self.assertTrue(h.verify())
        self.assertEqual(h.contains_point("3/2", "1/2"), "boundary")
        self.assertEqual(h.contains_point(9, 3), "outside")

    def test_all_collinear_keeps_only_endpoints(self):
        h = DynamicConvexHull()
        for i, x in enumerate([0, 1, 2, 3, 4, 5]):
            h.insert(f"p{i}", x, 2 * x)  # all on y = 2x
        self.assertEqual(ids(h), ["p0", "p5"])
        self.assertTrue(h.verify())
        # Deleting an endpoint exposes the next extreme point.
        h.delete("p5")
        self.assertEqual(ids(h), ["p0", "p4"])
        self.assertTrue(h.verify())
        h.delete("p0")
        self.assertEqual(ids(h), ["p1", "p4"])
        self.assertTrue(h.verify())

    def test_collinear_edge_interiors_excluded(self):
        h = DynamicConvexHull()
        h.insert("bl", 0, 0)
        h.insert("br", 4, 0)
        h.insert("mid1", 1, 0)  # on bottom edge
        h.insert("mid2", 3, 0)  # on bottom edge
        h.insert("top", 2, 2)
        self.assertEqual(ids(h), ["bl", "br", "top"])
        self.assertTrue(h.verify())


class TestDuplicates(unittest.TestCase):
    def test_same_coordinate_multiple_ids(self):
        h = DynamicConvexHull()
        h.insert("b1", 0, 0)
        h.insert("a1", 0, 0)  # same coord, smaller id
        h.insert("c1", 0, 0)
        h.insert("z", 5, 5)
        # Canonical representative at (0,0) is the smallest id.
        self.assertEqual(ids(h), ["a1", "z"])
        self.assertTrue(h.verify())
        # Deleting a non-representative duplicate must not change geometry.
        h.delete("c1")
        self.assertEqual(ids(h), ["a1", "z"])
        # Deleting the representative keeps geometry, swaps canonical id.
        h.delete("a1")
        self.assertEqual(ids(h), ["b1", "z"])
        self.assertTrue(h.verify())
        # Deleting the last point at the coordinate changes the geometry.
        h.delete("b1")
        self.assertEqual(ids(h), ["z"])
        self.assertTrue(h.verify())

    def test_duplicate_id_rejected(self):
        h = DynamicConvexHull()
        h.insert("a", 0, 0)
        with self.assertRaises(ValueError):
            h.insert("a", 1, 1)

    def test_delete_missing_rejected(self):
        h = DynamicConvexHull()
        with self.assertRaises(KeyError):
            h.delete("nope")

    def test_non_string_id_rejected(self):
        h = DynamicConvexHull()
        with self.assertRaises(TypeError):
            h.insert(7, 0, 0)


class TestExactness(unittest.TestCase):
    def test_near_identical_fractions(self):
        # A bump of height 1e-12: invisible to float64 rounding near 1e-16
        # perturbations, but exact rationals keep it.
        h = DynamicConvexHull()
        h.insert("a", 0, 0)
        h.insert("b", 1, Fraction(1, 10**12))
        h.insert("c", 2, 0)
        self.assertEqual(ids(h), ["a", "c", "b"])
        self.assertTrue(h.verify())
        h.insert("d", 1, Fraction(1, 10**12) - Fraction(1, 10**18))
        # d is below b, so the hull is unchanged.
        self.assertEqual(ids(h), ["a", "c", "b"])
        h.delete("b")
        # Now the tiny remaining bump d becomes a vertex.
        self.assertEqual(ids(h), ["a", "c", "d"])
        self.assertTrue(h.verify())
        h.delete("d")
        self.assertEqual(ids(h), ["a", "c"])
        self.assertTrue(h.verify())

    def test_lowest_terms_output(self):
        h = DynamicConvexHull()
        p = h.insert("a", "2/4", "6/9")
        self.assertEqual(p.x, Fraction(1, 2))
        self.assertEqual(p.y, Fraction(2, 3))

    def test_float_coordinates_rejected(self):
        h = DynamicConvexHull()
        with self.assertRaises(TypeError):
            h.insert("a", 0.1, 0.2)

    def test_large_denominators(self):
        h = DynamicConvexHull()
        h.insert("a", Fraction(1, 10**9), Fraction(2, 10**9 + 3))
        h.insert("b", Fraction(1, 10**9) + Fraction(1, 10**18), 0)
        h.insert("c", 1, 1)
        self.assertTrue(h.verify())


class TestBridgeExtremeDeletion(unittest.TestCase):
    def test_delete_extreme_point_bridging_chains(self):
        # Diamond: the rightmost point alone joins the upper and lower
        # chains; deleting it must re-bridge both chains.
        h = DynamicConvexHull()
        h.insert("l", 0, 0)
        h.insert("t", 2, 1)
        h.insert("r", 4, 0)
        h.insert("b", 2, -1)
        self.assertEqual(ids(h), ["l", "b", "r", "t"])
        self.assertTrue(h.verify())
        h.delete("r")
        self.assertEqual(ids(h), ["l", "b", "t"])
        self.assertTrue(h.verify())
        h.delete("t")
        self.assertEqual(ids(h), ["l", "b"])
        self.assertTrue(h.verify())
        h.delete("b")
        self.assertEqual(ids(h), ["l"])
        self.assertTrue(h.verify())
        h.delete("l")
        self.assertEqual(ids(h), [])
        self.assertTrue(h.verify())


class TestEvidence(unittest.TestCase):
    def test_square_half_planes(self):
        h = DynamicConvexHull()
        h.insert("a", 0, 0)
        h.insert("b", 2, 0)
        h.insert("c", 2, 2)
        h.insert("d", 0, 2)
        edges = h.hull().edges
        got = {(e.p1.id, e.p2.id): (e.a, e.b, e.c) for e in edges}
        self.assertEqual(
            got,
            {
                ("a", "b"): (0, 1, 0),     # y >= 0
                ("b", "c"): (-1, 0, 2),    # x <= 2
                ("c", "d"): (0, -1, 2),    # y <= 2
                ("d", "a"): (1, 0, 0),     # x >= 0
            },
        )
        self.assertTrue(h.verify())

    def test_ccw_order_and_canonical_start(self):
        h = DynamicConvexHull()
        h.insert("c", 2, 2)
        h.insert("a", 0, 0)
        h.insert("d", 0, 2)
        h.insert("b", 2, 0)
        self.assertEqual(ids(h), ["a", "b", "c", "d"])
        # Strictly counter-clockwise.
        from rational_hull import orient

        verts = h.hull().vertices
        for i in range(len(verts)):
            self.assertGreater(
                orient(verts[i], verts[(i + 1) % 4], verts[(i + 2) % 4]), 0
            )


if __name__ == "__main__":
    unittest.main()
