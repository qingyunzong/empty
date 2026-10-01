import unittest
from fractions import Fraction

from arrangement.atomic import atomic_decomposition
from arrangement.geom import to_point

F = Fraction


def P(x, y):
    return (F(x), F(y))


class TestAtomicDecomposition(unittest.TestCase):
    def test_overlap_chain_sources(self):
        # Three overlapping collinear segments form a chain.
        segs = {
            1: (P(0, 0), P(4, 0)),
            2: (P(2, 0), P(6, 0)),
            3: (P(5, 0), P(8, 0)),
        }
        res = atomic_decomposition(segs)
        atoms = sorted((a.p[0], a.q[0], a.sources) for a in res.segments)
        self.assertEqual(
            atoms,
            [
                (F(0), F(2), frozenset({1})),
                (F(2), F(4), frozenset({1, 2})),
                (F(4), F(5), frozenset({2})),
                (F(5), F(6), frozenset({2, 3})),
                (F(6), F(8), frozenset({3})),
            ],
        )

    def test_touching_segments_split_at_shared_endpoint(self):
        segs = {1: (P(0, 0), P(2, 0)), 2: (P(2, 0), P(5, 0))}
        res = atomic_decomposition(segs)
        atoms = sorted((a.p[0], a.q[0]) for a in res.segments)
        self.assertEqual(atoms, [(F(0), F(2)), (F(2), F(5))])

    def test_duplicate_segments_merge(self):
        segs = {1: (P(0, 0), P(3, 3)), 2: (P(0, 0), P(3, 3))}
        res = atomic_decomposition(segs)
        self.assertEqual(len(res.segments), 1)
        self.assertEqual(res.segments[0].sources, frozenset({1, 2}))

    def test_vertical_line_group(self):
        segs = {1: (P(1, 0), P(1, 4)), 2: (P(1, 2), P(1, 6))}
        res = atomic_decomposition(segs)
        atoms = sorted((a.p[1], a.q[1], a.sources) for a in res.segments)
        self.assertEqual(
            atoms,
            [
                (F(0), F(2), frozenset({1})),
                (F(2), F(4), frozenset({1, 2})),
                (F(4), F(6), frozenset({2})),
            ],
        )

    def test_zero_length_segments_are_points(self):
        segs = {1: (P(2, 2), P(2, 2)), 2: (P(0, 0), P(1, 1))}
        res = atomic_decomposition(segs)
        self.assertEqual(res.points, [(P(2, 2), 1)])
        self.assertEqual(len(res.segments), 1)


if __name__ == "__main__":
    unittest.main()
