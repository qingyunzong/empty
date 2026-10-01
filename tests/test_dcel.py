import unittest
from fractions import Fraction

from arrangement import Arrangement, verify_all


def square(x0, y0, s):
    return [
        [(x0, y0), (x0 + s, y0)],
        [(x0 + s, y0), (x0 + s, y0 + s)],
        [(x0 + s, y0 + s), (x0, y0 + s)],
        [(x0, y0 + s), (x0, y0)],
    ]


class TestFaces(unittest.TestCase):
    def test_single_square(self):
        arr = Arrangement(square(0, 0, 2))
        self.assertEqual(len(arr.faces), 2)
        inner = [f for f in arr.faces if not f.is_outer]
        outer = [f for f in arr.faces if f.is_outer]
        self.assertEqual(len(inner), 1)
        self.assertEqual(len(outer), 1)
        self.assertEqual(inner[0].area, Fraction(4))
        self.assertEqual(outer[0].area, Fraction(-4))
        ring = [h.origin for h in inner[0].halfedges]
        self.assertEqual(len(ring), 4)

    def test_nested_loops(self):
        arr = Arrangement(square(0, 0, 6) + square(1, 1, 2))
        self.assertEqual(arr.topology.components, 2)
        self.assertEqual(arr.topology.components_with_edges, 2)
        # faces: outer region, ring between squares, inner square interior,
        # plus the inner square's own outer cycle
        self.assertEqual(len(arr.faces), 4)
        self.assertEqual(arr.topology.euler_value(), 4)  # C + C_e
        self.assertTrue(verify_all(arr)["ok"])
        outer_cycles = [f for f in arr.faces if f.is_outer]
        self.assertEqual(len(outer_cycles), 2)  # one per component

    def test_dangling_edge(self):
        arr = Arrangement(square(0, 0, 2) + [[(2, 1), (4, 1)]])
        self.assertEqual(len(arr.faces), 2)  # spur adds no face
        self.assertTrue(verify_all(arr)["ok"])

    def test_isolated_point_segment(self):
        arr = Arrangement(square(0, 0, 2) + [[(5, 5), (5, 5)]])
        self.assertEqual(arr.topology.components, 2)
        self.assertEqual(arr.topology.components_with_edges, 1)
        self.assertEqual(arr.topology.euler_value(), 3)  # C + C_e = 3
        self.assertTrue(verify_all(arr)["ok"])
        pts = {v.point for v in arr.vertices}
        self.assertIn((Fraction(5), Fraction(5)), pts)

    def test_point_segment_on_edge_splits_it(self):
        arr = Arrangement([[(0, 0), (4, 0)], [(2, 0), (2, 0)]])
        self.assertEqual(len(arr.edges), 2)
        self.assertTrue(verify_all(arr)["ok"])

    def test_halfedge_pairing_and_ring_closure(self):
        arr = Arrangement(square(0, 0, 3) + [[(0, 0), (3, 3)]])
        for h in arr.halfedges:
            self.assertIs(h.twin.twin, h)
            self.assertIs(h.next.prev, h)
            self.assertIs(h.prev.next, h)
            self.assertEqual(h.next.origin, h.target)
        for face in arr.faces:
            self.assertIs(face.halfedges[-1].next, face.halfedges[0])


class TestAngularStitching(unittest.TestCase):
    def test_star_faces(self):
        # 6 spokes from a common center: 6 wedge faces + outer face
        coords = []
        pts = [(4, 0), (2, 3), (-2, 3), (-4, 0), (-2, -3), (2, -3)]
        for p in pts:
            coords.append([(0, 0), p])
        arr = Arrangement(coords)
        self.assertEqual(len(arr.faces), 1)  # no closed cycles: only outer
        self.assertTrue(verify_all(arr)["ok"])

    def test_exact_angle_order_no_float(self):
        # two rays whose slopes agree to 40+ decimal digits: atan would tie
        big = 10 ** 40
        arr = Arrangement([
            [(0, 0), (big, 1)],
            [(0, 0), (big * big, big + 1)],
            [(0, 0), (0, 1)],
            [(0, 0), (-1, 0)],
            [(0, 0), (0, -1)],
        ])
        report = verify_all(arr)
        self.assertTrue(report["ok"], report["checks"])
        self.assertEqual(report["checks"]["stitching"], [])


if __name__ == "__main__":
    unittest.main()
