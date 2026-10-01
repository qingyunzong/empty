import random
import tempfile
import unittest
from fractions import Fraction

from dynhull import DynamicHull, brute_hull_vertices, verify


class RandomUpdatesTest(unittest.TestCase):
    def test_random_updates_match_bruteforce(self):
        rng = random.Random(20261001)
        hull = DynamicHull()
        points = {}
        live = []
        # small denominator pool forces duplicates and collinearities
        pool = [(Fraction(a, 3), Fraction(b, 3))
                for a in range(-2, 3) for b in range(-2, 3)]
        for step in range(220):
            if live and rng.random() < 0.45:
                pid = live.pop(rng.randrange(len(live)))
                hull.delete(pid)
                del points[pid]
            else:
                pid = step
                x, y = rng.choice(pool)
                hull.insert(pid, x, y)
                points[pid] = (x, y)
                live.append(pid)
            self.assertEqual(hull.vertices(), brute_hull_vertices(points),
                             f"step {step}")
            self.assertTrue(verify(points, hull.hull()), f"step {step}")

    def test_all_collinear(self):
        hull = DynamicHull()
        points = {}
        for i in range(6):
            hull.insert(i, Fraction(i, 2), Fraction(i))
            points[i] = (Fraction(i, 2), Fraction(i))
        # only the two extreme endpoints survive as vertices
        self.assertEqual(hull.vertices(), [(0, Fraction(0), Fraction(0)),
                                           (5, Fraction(5, 2), Fraction(5))])
        self.assertTrue(verify(points, hull.hull()))
        hull.delete(5)
        del points[5]
        self.assertEqual(hull.vertices(), brute_hull_vertices(points))
        self.assertTrue(verify(points, hull.hull()))
        # vertical collinear run
        hull2 = DynamicHull()
        pts2 = {}
        for i in range(4):
            hull2.insert(i, Fraction(2), Fraction(i, 3))
            pts2[i] = (Fraction(2), Fraction(i, 3))
        self.assertEqual(hull2.vertices(), brute_hull_vertices(pts2))
        self.assertTrue(verify(pts2, hull2.hull()))

    def test_duplicate_coordinates(self):
        hull = DynamicHull()
        points = {}
        coords = [(0, 0), (0, 0), (0, 0), (1, 0), (0, 1), (0, 1)]
        for pid, (x, y) in enumerate(coords):
            hull.insert(pid, x, y)
            points[pid] = (Fraction(x), Fraction(y))
        self.assertEqual(len(hull.vertices()), 3)
        self.assertTrue(verify(points, hull.hull()))
        # deleting one of several same-coordinate points keeps geometry
        hull_before = hull.vertices()
        hull.delete(0)
        del points[0]
        self.assertEqual([(x, y) for _, x, y in hull.vertices()],
                         [(x, y) for _, x, y in hull_before])
        hull.delete(1)
        del points[1]
        self.assertEqual([(x, y) for _, x, y in hull.vertices()],
                         [(x, y) for _, x, y in hull_before])
        # deleting the last point at (0,0) changes the geometry
        hull.delete(2)
        del points[2]
        self.assertNotEqual([(x, y) for _, x, y in hull.vertices()],
                            [(x, y) for _, x, y in hull_before])
        self.assertEqual(hull.vertices(), brute_hull_vertices(points))
        self.assertTrue(verify(points, hull.hull()))

    def test_delete_bridging_extreme_point(self):
        # (4,0) is the unique max-x point where upper and lower chains meet
        hull = DynamicHull()
        points = {}
        data = [(0, 0), (2, 1), (2, -1), (4, 0)]
        for pid, (x, y) in enumerate(data):
            hull.insert(pid, x, y)
            points[pid] = (Fraction(x), Fraction(y))
        self.assertEqual(len(hull.vertices()), 4)
        hull.delete(3)
        del points[3]
        self.assertEqual(hull.vertices(), brute_hull_vertices(points))
        self.assertEqual([(x, y) for _, x, y in hull.vertices()],
                         [(Fraction(0), Fraction(0)), (Fraction(2), Fraction(-1)),
                          (Fraction(2), Fraction(1))])
        self.assertTrue(verify(points, hull.hull()))

    def test_near_fractions_exactness(self):
        hull = DynamicHull()
        points = {}
        data = [(0, 0), (2, 0), (1, Fraction(1, 10 ** 12))]
        for pid, (x, y) in enumerate(data):
            hull.insert(pid, x, y)
            points[pid] = (Fraction(x), Fraction(y))
        # a height of 1e-12 is tiny but nonzero: three vertices
        self.assertEqual(len(hull.vertices()), 3)
        self.assertTrue(verify(points, hull.hull()))
        # exactly collinear rationals: middle point must disappear
        hull2 = DynamicHull()
        pts2 = {}
        exact = [(0, 0), (1, Fraction(1, 3)), (2, Fraction(2, 3))]
        for pid, (x, y) in enumerate(exact):
            hull2.insert(pid, x, y)
            pts2[pid] = (Fraction(x), Fraction(y))
        self.assertEqual(len(hull2.vertices()), 2)
        # one ulp above the line: vertex appears (floats could not tell)
        hull2.insert(3, 1, Fraction(1, 3) + Fraction(1, 10 ** 15))
        pts2[3] = (Fraction(1), Fraction(1, 3) + Fraction(1, 10 ** 15))
        self.assertEqual(len(hull2.vertices()), 3)
        self.assertEqual(hull2.vertices(), brute_hull_vertices(pts2))
        self.assertTrue(verify(pts2, hull2.hull()))

    def test_nested_snapshots_and_diverge(self):
        rng = random.Random(99)
        hull = DynamicHull()
        points = {}
        pool = [(Fraction(a, 2), Fraction(b, 2))
                for a in range(-2, 3) for b in range(-2, 3)]
        for pid in range(8):
            x, y = rng.choice(pool)
            hull.insert(pid, x, y)
            points[pid] = (x, y)
        tok1 = hull.checkpoint()
        # branch A
        pts_a = dict(points)
        hull.insert(100, 5, 5)
        pts_a[100] = (Fraction(5), Fraction(5))
        tok2 = hull.checkpoint()
        hull.insert(101, -5, 5)
        pts_a2 = dict(pts_a)
        pts_a2[101] = (Fraction(-5), Fraction(5))
        self.assertEqual(hull.vertices(), brute_hull_vertices(pts_a2))
        hull.rollback(tok2)  # inner rollback
        self.assertEqual(hull.vertices(), brute_hull_vertices(pts_a))
        # diverge after rollback: different continuation
        hull.insert(102, 5, -5)
        pts_a[102] = (Fraction(5), Fraction(-5))
        self.assertEqual(hull.vertices(), brute_hull_vertices(pts_a))
        hull.rollback(tok1)  # outer rollback undoes the whole branch
        self.assertEqual(hull.vertices(), brute_hull_vertices(points))
        # and diverge again from the restored state
        hull.insert(103, -5, -5)
        pts_b = dict(points)
        pts_b[103] = (Fraction(-5), Fraction(-5))
        self.assertEqual(hull.vertices(), brute_hull_vertices(pts_b))
        self.assertTrue(verify(pts_b, hull.hull()))
        with self.assertRaises(RuntimeError):
            hull.rollback()  # nothing left on the stack

    def test_save_and_load(self):
        rng = random.Random(7)
        hull = DynamicHull()
        points = {}
        for pid in range(40):
            x = Fraction(rng.randrange(-50, 51), 7)
            y = Fraction(rng.randrange(-50, 51), 11)
            hull.insert(pid, x, y)
            points[pid] = (x, y)
        with tempfile.NamedTemporaryFile("r+", suffix=".json") as fh:
            hull.save(fh.name)
            # mutate after saving
            hull.insert(1000, 99, 99)
            hull.delete(0)
            self.assertNotEqual(hull.vertices(), brute_hull_vertices(points))
            hull.load(fh.name)
        self.assertEqual(hull.vertices(), brute_hull_vertices(points))
        self.assertTrue(verify(points, hull.hull()))
        # hull stays fully functional after reload
        hull.insert(2000, Fraction(100, 3), Fraction(-7, 5))
        points[2000] = (Fraction(100, 3), Fraction(-7, 5))
        self.assertEqual(hull.vertices(), brute_hull_vertices(points))
        self.assertTrue(verify(points, hull.hull()))

    def test_rejects_floats(self):
        hull = DynamicHull()
        with self.assertRaises(TypeError):
            hull.insert(1, 0.5, 0)
        with self.assertRaises(TypeError):
            hull.extreme(1.0, 0)


if __name__ == "__main__":
    unittest.main()
