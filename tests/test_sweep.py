import random
import unittest
from fractions import Fraction

from arrangement.atomic import atomic_decomposition
from arrangement.geom import on_segment, proper_intersection
from arrangement.sweep import sweep_intersections

F = Fraction


def P(x, y):
    return (F(x), F(y))


def pairwise_reference(atoms):
    """All points where >= 2 atomic segments meet (brute force)."""
    pts = set()
    for i in range(len(atoms)):
        for j in range(i + 1, len(atoms)):
            a, b = atoms[i], atoms[j]
            hit = proper_intersection(a.p, a.q, b.p, b.q)
            if hit is not None:
                pts.add(hit)
            else:
                # Collinear atoms are disjoint, but may share an endpoint.
                for p in (a.p, a.q):
                    if on_segment(p, b.p, b.q):
                        pts.add(p)
                for p in (b.p, b.q):
                    if on_segment(p, a.p, a.q):
                        pts.add(p)
    return pts


def sweep_of(segs):
    res = atomic_decomposition(segs)
    return set(sweep_intersections(res.segments)), res.segments


class TestSweepIntersections(unittest.TestCase):
    def test_crossing(self):
        found, _ = sweep_of({1: (P(0, 0), P(4, 4)), 2: (P(0, 4), P(4, 0))})
        self.assertEqual(found, {(F(2), F(2))})

    def test_t_junction(self):
        found, _ = sweep_of({1: (P(0, 0), P(4, 0)), 2: (P(2, 0), P(2, 3))})
        self.assertEqual(found, {(F(2), F(0))})

    def test_multi_segment_single_point(self):
        segs = {
            1: (P(0, 0), P(4, 4)),
            2: (P(0, 4), P(4, 0)),
            3: (P(2, 0), P(2, 4)),
            4: (P(0, 2), P(4, 2)),
        }
        found, _ = sweep_of(segs)
        self.assertEqual(found, {(F(2), F(2))})

    def test_vertical_segments(self):
        segs = {
            1: (P(2, 0), P(2, 5)),   # vertical
            2: (P(0, 3), P(5, 3)),   # horizontal crossing
            3: (P(0, 1), P(5, 1)),   # horizontal crossing
            4: (P(4, 0), P(4, 2)),   # vertical crossing segment 3
        }
        found, _ = sweep_of(segs)
        self.assertEqual(found, {(F(2), F(3)), (F(2), F(1)), (F(4), F(1))})

    def test_shared_endpoints(self):
        segs = {1: (P(0, 0), P(2, 0)), 2: (P(2, 0), P(2, 2))}
        found, _ = sweep_of(segs)
        self.assertEqual(found, {(F(2), F(0))})

    def test_collinear_touching_atoms(self):
        # Overlap chain: atoms touch at endpoints along one line.
        segs = {1: (P(0, 0), P(4, 0)), 2: (P(2, 0), P(6, 0))}
        found, atoms = sweep_of(segs)
        self.assertEqual(len(atoms), 3)
        # Atoms meet at the points where the source sets change.
        self.assertEqual(found, {(F(2), F(0)), (F(4), F(0))})

    def test_sweep_matches_pairwise_random(self):
        rng = random.Random(20261001)
        for trial in range(60):
            n = rng.randint(2, 9)
            segs = {}
            for i in range(n):
                while True:
                    x1, y1 = rng.randint(-6, 6), rng.randint(-6, 6)
                    x2, y2 = rng.randint(-6, 6), rng.randint(-6, 6)
                    if (x1, y1) != (x2, y2):
                        break
                segs[i + 1] = (P(x1, y1), P(x2, y2))
            res = atomic_decomposition(segs)
            found = set(sweep_intersections(res.segments))
            reference = pairwise_reference(res.segments)
            endpoints = set()
            for a in res.segments:
                endpoints.add(a.p)
                endpoints.add(a.q)
            self.assertEqual(found, reference - endpoints | (found & endpoints),
                             f"trial {trial}: {segs}")
            self.assertTrue(reference <= (found | endpoints),
                            f"trial {trial}: missed {reference - found - endpoints}")

    def test_no_pairwise_loops_in_sweep(self):
        # The sweep module must discover intersections via the event
        # queue / active status, not by enumerating all pairs.
        import inspect

        import arrangement.sweep as sweep_mod
        src = inspect.getsource(sweep_mod.sweep_intersections)
        self.assertNotIn("for j in range(i + 1", src)


if __name__ == "__main__":
    unittest.main()
