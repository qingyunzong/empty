import random
import unittest
from fractions import Fraction

from dynhull import (DynamicHull, brute_extreme, brute_tangents,
                     brute_hull_vertices, verify)


def build(points):
    hull = DynamicHull()
    for pid, (x, y) in points.items():
        hull.insert(pid, x, y)
    return hull


class QueryTest(unittest.TestCase):
    def test_extreme_matches_bruteforce(self):
        rng = random.Random(4242)
        for trial in range(30):
            points = {}
            for pid in range(rng.randrange(1, 25)):
                points[pid] = (Fraction(rng.randrange(-20, 21),
                                        rng.choice([1, 2, 3])),
                               Fraction(rng.randrange(-20, 21),
                                        rng.choice([1, 2, 3])))
            hull = build(points)
            for _ in range(12):
                dx = Fraction(rng.randrange(-5, 6), rng.choice([1, 2]))
                dy = Fraction(rng.randrange(-5, 6), rng.choice([1, 2]))
                if dx == 0 and dy == 0:
                    continue
                self.assertEqual(hull.extreme(dx, dy),
                                 brute_extreme(points, (dx, dy)),
                                 f"trial {trial} dir ({dx},{dy})")

    def test_extreme_tie_rule(self):
        # square: direction (1,0) ties on the right edge -> smallest (x,y)
        points = {0: (Fraction(0), Fraction(0)), 1: (Fraction(0), Fraction(2)),
                  2: (Fraction(2), Fraction(0)), 3: (Fraction(2), Fraction(2))}
        hull = build(points)
        self.assertEqual(hull.extreme(1, 0), (2, Fraction(2), Fraction(0)))
        self.assertEqual(hull.extreme(0, 1), (1, Fraction(0), Fraction(2)))
        # several ids stacked on the winning coordinate -> smallest id
        points[4] = (Fraction(2), Fraction(0))
        points[5] = (Fraction(2), Fraction(0))
        hull = build(points)
        self.assertEqual(hull.extreme(1, 0), (2, Fraction(2), Fraction(0)))

    def test_tangent_matches_bruteforce(self):
        rng = random.Random(777)
        for trial in range(18):
            points = {}
            for pid in range(rng.randrange(3, 20)):
                points[pid] = (Fraction(rng.randrange(-10, 11), 2),
                               Fraction(rng.randrange(-10, 11), 2))
            hull = build(points)
            for _ in range(6):
                q = (Fraction(rng.randrange(-15, 16), 2),
                     Fraction(rng.randrange(-15, 16), 2))
                self.assertEqual(hull.tangents(*q), brute_tangents(points, q),
                                 f"trial {trial} q={q}")

    def test_tangent_collinear_tie(self):
        # q lies on the line of the bottom edge extended: both (0,0) and
        # (4,0) are valid tangent points; rule picks smallest (x, y)
        points = {0: (Fraction(0), Fraction(0)), 1: (Fraction(4), Fraction(0)),
                  2: (Fraction(2), Fraction(3))}
        hull = build(points)
        left, right = hull.tangents(Fraction(6), Fraction(0))
        # hull lies left of ray q->(2,3): that is the "right" tangent
        self.assertEqual(right, (2, Fraction(2), Fraction(3)))
        self.assertEqual(left, (0, Fraction(0), Fraction(0)))

    def test_tangent_inside_is_none(self):
        points = {0: (Fraction(0), Fraction(0)), 1: (Fraction(4), Fraction(0)),
                  2: (Fraction(0), Fraction(4))}
        hull = build(points)
        self.assertIsNone(hull.tangents(1, 1))          # strictly inside
        self.assertIsNone(hull.tangents(2, 0))          # on the boundary
        self.assertIsNone(hull.tangents(0, 0))          # on a vertex
        self.assertIsNotNone(hull.tangents(-1, -1))     # outside

    def test_degenerate_hulls(self):
        hull = DynamicHull()
        self.assertIsNone(hull.extreme(1, 0))
        self.assertIsNone(hull.tangents(5, 5))
        hull.insert(7, Fraction(1, 2), Fraction(3, 2))
        self.assertEqual(hull.extreme(1, 1), (7, Fraction(1, 2), Fraction(3, 2)))
        self.assertEqual(hull.tangents(9, 9),
                         ((7, Fraction(1, 2), Fraction(3, 2)),
                          (7, Fraction(1, 2), Fraction(3, 2))))
        hull.insert(8, Fraction(5), Fraction(6))
        self.assertEqual(hull.tangents(0, 0),
                         ((7, Fraction(1, 2), Fraction(3, 2)),
                          (8, Fraction(5), Fraction(6))))
        self.assertTrue(verify({7: (Fraction(1, 2), Fraction(3, 2)),
                                8: (Fraction(5), Fraction(6))}, hull.hull()))


if __name__ == "__main__":
    unittest.main()
