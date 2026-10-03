"""The independent checker must accept valid hulls and reject tampered ones."""

import unittest

from rational_hull import (
    DynamicConvexHull,
    Edge,
    HullResult,
    Point,
    VerificationError,
    edge_coefficients,
    verify_hull,
)


def make_square():
    h = DynamicConvexHull()
    h.insert("a", 0, 0)
    h.insert("b", 2, 0)
    h.insert("c", 2, 2)
    h.insert("d", 0, 2)
    h.insert("i", 1, 1)  # interior
    return h


class TestCheckerAccepts(unittest.TestCase):
    def test_valid_hull_passes(self):
        h = make_square()
        self.assertTrue(verify_hull(h.hull(), h.points()))

    def test_degenerate_hulls_pass(self):
        h = DynamicConvexHull()
        self.assertTrue(verify_hull(h.hull(), h.points()))
        h.insert("a", 1, 1)
        h.insert("b", 1, 1)
        self.assertTrue(verify_hull(h.hull(), h.points()))
        h.insert("c", 3, 3)
        h.insert("d", 2, 2)  # collinear interior of the segment
        self.assertTrue(verify_hull(h.hull(), h.points()))


class TestCheckerRejects(unittest.TestCase):
    def setUp(self):
        self.h = make_square()
        self.good = self.h.hull()
        self.points = self.h.points()

    def assert_bad(self, hull):
        with self.assertRaises(VerificationError):
            verify_hull(hull, self.points)

    def test_missing_vertex(self):
        # Dropping vertex c: the recomputed b->d evidence is geometrically
        # consistent, but active point c violates its half-plane.
        verts = [v for v in self.good.vertices if v.id != "c"]
        edges = []
        for i in range(len(verts)):
            a, b = verts[i], verts[(i + 1) % len(verts)]
            ca, cb, cc = edge_coefficients(a, b)
            edges.append(Edge(a, b, ca, cb, cc))
        self.assert_bad(HullResult(verts, edges))

    def test_forged_vertex_id(self):
        verts = [
            Point("ghost", v.x, v.y) if v.id == "c" else v
            for v in self.good.vertices
        ]
        self.assert_bad(HullResult(verts, self.good.edges))

    def test_wrong_representative_id(self):
        h = DynamicConvexHull()
        h.insert("zz", 0, 0)
        h.insert("aa", 0, 0)  # canonical representative at (0,0)
        h.insert("b", 1, 0)
        h.insert("c", 0, 1)
        verts = [
            Point("zz", v.x, v.y) if v.id == "aa" else v
            for v in h.hull().vertices
        ]
        with self.assertRaises(VerificationError):
            verify_hull(HullResult(verts, h.hull().edges), h.points())

    def test_tampered_evidence(self):
        edges = [
            Edge(e.p1, e.p2, e.a, e.b, e.c + 1) if i == 0 else e
            for i, e in enumerate(self.good.edges)
        ]
        self.assert_bad(HullResult(self.good.vertices, edges))

    def test_clockwise_order_rejected(self):
        verts = list(reversed(self.good.vertices))
        self.assert_bad(HullResult(verts, self.good.edges))

    def test_collinear_triple_rejected(self):
        mid = Point("m", 1, 0)
        verts = list(self.good.vertices)
        verts.insert(1, mid)  # collinear with a->b
        self.assert_bad(HullResult(verts, self.good.edges))

    def test_interior_point_claimed_as_vertex(self):
        fake = Point("i", 1, 1)
        verts = list(self.good.vertices) + [fake]
        self.assert_bad(HullResult(verts, self.good.edges))


if __name__ == "__main__":
    unittest.main()
