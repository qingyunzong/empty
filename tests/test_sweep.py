import random
import unittest
from fractions import Fraction

from arrangement import Arrangement, verify_all
from arrangement.geometry import make_point
from arrangement.sweep import (
    atomic_decomposition,
    split_atoms,
    sweep_intersections,
)

try:
    from .oracle import reference_edges, sweep_edges
except ImportError:  # unittest discover -s tests (top-level modules)
    from oracle import reference_edges, sweep_edges


def segs(coords):
    return [(make_point(a), make_point(b), i + 1) for i, (a, b) in enumerate(coords)]


class TestAtomicDecomposition(unittest.TestCase):
    def test_overlap_chain(self):
        atoms, _ = atomic_decomposition(
            segs([[(0, 0), (2, 0)], [(1, 0), (3, 0)], [(2, 0), (4, 0)]])
        )
        pieces = [(a.p, a.q, a.sources) for a in atoms]
        self.assertEqual(
            pieces,
            [
                (make_point((0, 0)), make_point((1, 0)), frozenset({1})),
                (make_point((1, 0)), make_point((2, 0)), frozenset({1, 2})),
                (make_point((2, 0)), make_point((3, 0)), frozenset({2, 3})),
                (make_point((3, 0)), make_point((4, 0)), frozenset({3})),
            ],
        )

    def test_duplicate_segments_merge_sources(self):
        atoms, _ = atomic_decomposition(
            segs([[(0, 0), (1, 1)], [(0, 0), (1, 1)], [(1, 1), (0, 0)]])
        )
        self.assertEqual(len(atoms), 1)
        self.assertEqual(atoms[0].sources, frozenset({1, 2, 3}))

    def test_vertical_overlap(self):
        atoms, _ = atomic_decomposition(
            segs([[(2, 0), (2, 5)], [(2, 3), (2, 8)]])
        )
        self.assertEqual(len(atoms), 3)
        self.assertEqual(atoms[1].sources, frozenset({1, 2}))


class TestSweep(unittest.TestCase):
    def _run(self, coords):
        atoms, _ = atomic_decomposition(segs(coords))
        splits, points = sweep_intersections(atoms)
        return atoms, splits, points

    def test_cross(self):
        _, splits, points = self._run([[(0, 0), (4, 4)], [(0, 4), (4, 0)]])
        self.assertIn((Fraction(2), Fraction(2)), points)
        for s in splits.values():
            self.assertIn((Fraction(2), Fraction(2)), s)

    def test_vertical_horizontal(self):
        _, _, points = self._run([[(2, -1), (2, 5)], [(-1, 3), (7, 3)]])
        self.assertIn((Fraction(2), Fraction(3)), points)

    def test_t_junction(self):
        atoms, splits, points = self._run([[(0, 0), (6, 0)], [(3, 0), (3, 4)]])
        self.assertIn((Fraction(3), Fraction(0)), points)
        self.assertIn((Fraction(3), Fraction(0)), splits[atoms[0].index])

    def test_many_segments_one_point(self):
        coords = [
            [(0, 0), (4, 4)],
            [(0, 4), (4, 0)],
            [(2, 0), (2, 4)],
            [(0, 2), (4, 2)],
            [(0, 1), (4, 3)],
        ]
        _, splits, points = self._run(coords)
        center = (Fraction(2), Fraction(2))
        self.assertIn(center, points)
        hit = sum(1 for s in splits.values() if center in s)
        self.assertEqual(hit, 5)

    def test_shared_endpoints(self):
        _, _, points = self._run(
            [[(0, 0), (2, 0)], [(2, 0), (2, 2)], [(2, 2), (4, 2)]]
        )
        self.assertIn((Fraction(2), Fraction(0)), points)
        self.assertIn((Fraction(2), Fraction(2)), points)

    def test_vertical_chain_and_crossing(self):
        coords = [
            [(1, 0), (1, 2)],
            [(1, 2), (1, 4)],   # collinear continuation (shared endpoint)
            [(0, 3), (2, 3)],   # crosses the vertical at (1,3)
            [(0, 1), (2, 1)],   # crosses at (1,1)
        ]
        _, _, points = self._run(coords)
        self.assertIn((Fraction(1), Fraction(1)), points)
        self.assertIn((Fraction(1), Fraction(3)), points)

    def test_rational_intersection_exact(self):
        _, _, points = self._run(
            [[(0, 0), (3, 1)], [(0, 1), (3, 0)]]
        )
        self.assertIn((Fraction(3, 2), Fraction(1, 2)), points)


class TestSweepVsOracle(unittest.TestCase):
    """Sweep-line construction must match brute-force pairwise splitting."""

    def _check(self, coords):
        arr = Arrangement(coords)
        tagged = [
            (p, q, sid) for sid, (p, q) in arr.segments.items()
        ]
        self.assertEqual(sweep_edges(arr), reference_edges(tagged))
        report = verify_all(arr)
        self.assertTrue(report["ok"], report["checks"])

    def test_fixed_cases(self):
        self._check([[(0, 0), (4, 0)], [(2, -1), (2, 3)]])          # T / cross
        self._check([[(0, 0), (2, 0)], [(1, 0), (3, 0)], [(2, 0), (2, 2)]])
        self._check([[(0, 0), (3, 3)], [(0, 3), (3, 0)], [(1, 0), (1, 4)]])
        self._check([[(0, 0), (1, 1)], [(2, 2), (3, 3)]])           # collinear gap
        self._check([[(0, 0), (0, 0)], [(1, 1), (1, 1)]])           # point segs

    def test_random_small(self):
        rng = random.Random(20261001)
        for trial in range(60):
            n = rng.randint(2, 7)
            coords = []
            for _ in range(n):
                x1, y1 = rng.randint(0, 5), rng.randint(0, 5)
                x2, y2 = rng.randint(0, 5), rng.randint(0, 5)
                if rng.random() < 0.25:
                    x2 = x1  # force verticals
                if rng.random() < 0.2:
                    y2 = y1  # force horizontals / overlaps
                coords.append([(x1, y1), (x2, y2)])
            with self.subTest(trial=trial, coords=coords):
                self._check(coords)

    def test_random_rational(self):
        rng = random.Random(7)
        for trial in range(30):
            n = rng.randint(2, 6)
            coords = []
            for _ in range(n):
                def coord():
                    return f"{rng.randint(0, 12)}/{rng.randint(1, 4)}"
                coords.append([(coord(), coord()), (coord(), coord())])
            with self.subTest(trial=trial, coords=coords):
                self._check(coords)


if __name__ == "__main__":
    unittest.main()
