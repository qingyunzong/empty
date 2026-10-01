import unittest

from crdtsim.dvv import CausalContext


def ctx(points):
    return CausalContext.from_points(points)


class TestCompression(unittest.TestCase):
    def test_contiguous_points_compress_to_clock(self):
        c = ctx([("a", 1, 1), ("a", 1, 2), ("a", 1, 3)])
        self.assertEqual(c.clock, {("a", 1): 3})
        self.assertEqual(c.dots, frozenset())

    def test_noncontiguous_dots_are_retained(self):
        c = ctx([("a", 1, 1), ("a", 1, 3)])
        self.assertEqual(c.clock, {("a", 1): 1})
        self.assertEqual(c.dots, frozenset({("a", 1, 3)}))

    def test_gap_cannot_masquerade_as_prefix(self):
        c = ctx([("a", 1, 1), ("a", 1, 3)])
        self.assertFalse(c.contains(("a", 1, 2)))
        self.assertTrue(c.contains(("a", 1, 3)))
        need = ctx([("a", 1, 2)])
        self.assertFalse(need.leq(c))

    def test_merge_fills_gap_and_recompresses(self):
        left = ctx([("a", 1, 1), ("a", 1, 3)])
        right = ctx([("a", 1, 2)])
        merged = left.merge(right)
        self.assertEqual(merged.clock, {("a", 1): 3})
        self.assertEqual(merged.dots, frozenset())

    def test_epochs_are_independent_streams(self):
        c = ctx([("a", 1, 1), ("a", 2, 1)])
        self.assertEqual(c.clock, {("a", 1): 1, ("a", 2): 1})
        self.assertFalse(c.contains(("a", 2, 2)))


class TestLatticeLaws(unittest.TestCase):
    def setUp(self):
        self.a = ctx([("a", 1, 1), ("a", 1, 2), ("b", 1, 1)])
        self.b = ctx([("a", 1, 2), ("b", 2, 1), ("b", 2, 3)])
        self.c = ctx([("c", 1, 1)])

    def test_commutative(self):
        self.assertEqual(self.a.merge(self.b), self.b.merge(self.a))

    def test_associative(self):
        self.assertEqual(
            self.a.merge(self.b).merge(self.c),
            self.a.merge(self.b.merge(self.c)),
        )

    def test_idempotent(self):
        self.assertEqual(self.b.merge(self.b), self.b)
        self.assertEqual(
            self.a.merge(self.b).merge(self.b), self.a.merge(self.b)
        )

    def test_dominance_and_concurrency(self):
        bigger = self.a.merge(self.b)
        self.assertTrue(bigger.dominates(self.a))
        self.assertTrue(self.a.leq(bigger))
        self.assertTrue(self.a.concurrent(self.c))
        self.assertFalse(self.a.dominates(self.a))

    def test_minus_extracts_single_dot(self):
        base = ctx([("a", 1, 1), ("a", 1, 2)])
        deps = base.minus(("a", 1, 2))
        self.assertEqual(deps.clock, {("a", 1): 1})
        self.assertFalse(deps.contains(("a", 1, 2)))

    def test_next_dot(self):
        c = ctx([("a", 1, 1)])
        self.assertEqual(c.next_dot("a", 1), ("a", 1, 2))
        self.assertEqual(c.next_dot("a", 2), ("a", 2, 1))

    def test_json_roundtrip(self):
        c = ctx([("a", 1, 1), ("a", 1, 3), ("b", 2, 1)])
        self.assertEqual(CausalContext.from_json(c.to_json()), c)


if __name__ == "__main__":
    unittest.main()
