import unittest
from fractions import Fraction

from dynhull import DynamicHull, verify


def sample():
    points = {0: (Fraction(0), Fraction(0)), 1: (Fraction(4), Fraction(0)),
              2: (Fraction(4), Fraction(4)), 3: (Fraction(0), Fraction(4)),
              4: (Fraction(2), Fraction(2))}
    hull = DynamicHull()
    for pid, (x, y) in points.items():
        hull.insert(pid, x, y)
    return points, hull


class CheckerTest(unittest.TestCase):
    def test_valid_hull_passes(self):
        points, hull = sample()
        self.assertTrue(verify(points, hull.hull()))

    def test_rejects_phantom_vertex(self):
        points, hull = sample()
        obj = hull.hull()
        obj["vertices"].append({"id": 99, "x": Fraction(1), "y": Fraction(1)})
        self.assertFalse(verify(points, obj))

    def test_rejects_missing_vertex(self):
        points, hull = sample()
        obj = hull.hull()
        del obj["vertices"][2]  # drop (4,4): (2,2) would stick out
        obj["edges"] = obj["edges"][:2]
        self.assertFalse(verify(points, obj))

    def test_rejects_wrong_order(self):
        points, hull = sample()
        obj = hull.hull()
        obj["vertices"] = [obj["vertices"][1]] + obj["vertices"][:1] + obj["vertices"][2:]
        self.assertFalse(verify(points, obj))

    def test_rejects_bad_evidence(self):
        points, hull = sample()
        obj = hull.hull()
        obj["edges"][0]["a"] += 1
        self.assertFalse(verify(points, obj))

    def test_rejects_interior_point_left_out(self):
        points, hull = sample()
        obj = hull.hull()
        points[5] = (Fraction(10), Fraction(10))  # outside reported hull
        self.assertFalse(verify(points, obj))


if __name__ == "__main__":
    unittest.main()
