import unittest

from dvv.context import CausalContext


def ctx(*dots):
    return CausalContext.from_dots(dots)


class TestHoles(unittest.TestCase):
    def test_hole_is_not_contiguous_prefix(self):
        c = ctx(("a", 1, 1), ("a", 1, 3))
        self.assertIn(("a", 1, 1), c)
        self.assertIn(("a", 1, 3), c)
        self.assertNotIn(("a", 1, 2), c)
        self.assertEqual(c.entries[("a", 1)][0], 1)  # prefix stops at 1

    def test_hole_filled_folds_into_prefix(self):
        c = ctx(("a", 1, 1), ("a", 1, 3))
        self.assertTrue(c.add(("a", 1, 2)))
        self.assertEqual(c.entries[("a", 1)], [3, set()])
        self.assertTrue(c.is_canonical())

    def test_add_duplicate_returns_false(self):
        c = ctx(("a", 1, 1))
        self.assertFalse(c.add(("a", 1, 1)))

    def test_holey_vector_not_leq_prefix(self):
        holey = ctx(("a", 1, 1), ("a", 1, 3))
        prefix = ctx(("a", 1, 1), ("a", 1, 2))
        self.assertFalse(holey.leq(prefix))
        self.assertFalse(prefix.leq(holey))
        self.assertEqual(holey.compare(prefix), "concurrent")

    def test_from_json_rejects_noncanonical(self):
        with self.assertRaises(ValueError):
            CausalContext.from_json(
                [{"node": "a", "epoch": 1, "contig": 1, "dots": [2]}])
        with self.assertRaises(ValueError):
            CausalContext.from_json(
                [{"node": "a", "epoch": 1, "contig": 2, "dots": [1]}])

    def test_epochs_are_independent(self):
        c = ctx(("a", 1, 1), ("a", 2, 1))
        self.assertIn(("a", 1, 1), c)
        self.assertIn(("a", 2, 1), c)
        self.assertNotIn(("a", 1, 2), c)
        self.assertNotIn(("a", 2, 2), c)


class TestMergeLattice(unittest.TestCase):
    def setUp(self):
        self.a = ctx(("a", 1, 1), ("a", 1, 3), ("b", 1, 1))
        self.b = ctx(("a", 1, 2), ("b", 1, 2), ("c", 1, 5))
        self.c = ctx(("a", 1, 4), ("c", 1, 1))

    def test_commutative(self):
        self.assertEqual(self.a.merge(self.b), self.b.merge(self.a))

    def test_associative(self):
        left = self.a.merge(self.b).merge(self.c)
        right = self.a.merge(self.b.merge(self.c))
        self.assertEqual(left, right)

    def test_idempotent(self):
        self.assertEqual(self.a.merge(self.a), self.a)
        self.assertEqual(self.a.merge(self.b).merge(self.b), self.a.merge(self.b))

    def test_merge_unifies_dot_sets(self):
        merged = self.a.merge(self.b)
        for dot in [("a", 1, 1), ("a", 1, 2), ("a", 1, 3),
                    ("b", 1, 1), ("b", 1, 2), ("c", 1, 5)]:
            self.assertIn(dot, merged)
        self.assertNotIn(("c", 1, 4), merged)
        # {1,2,3} folds into a contiguous prefix
        self.assertEqual(merged.entries[("a", 1)], [3, set()])

    def test_leq_and_compare(self):
        small = ctx(("a", 1, 1))
        big = ctx(("a", 1, 1), ("a", 1, 2))
        self.assertTrue(small.leq(big))
        self.assertEqual(small.compare(big), "less")
        self.assertEqual(big.compare(small), "greater")
        self.assertEqual(big.compare(big.copy()), "equal")

    def test_meet(self):
        left = ctx(("a", 1, 1), ("a", 1, 2), ("a", 1, 3), ("b", 1, 1))
        right = ctx(("a", 1, 1), ("a", 1, 3), ("b", 1, 1), ("b", 1, 2))
        m = left.meet(right)
        # a: prefix {1} common; 2 only on the left; extra dot 3 on both
        self.assertIn(("a", 1, 1), m)
        self.assertIn(("a", 1, 3), m)
        self.assertNotIn(("a", 1, 2), m)
        self.assertIn(("b", 1, 1), m)
        self.assertNotIn(("b", 1, 2), m)
        self.assertEqual(m.entries[("a", 1)], [1, {3}])

    def test_serialization_roundtrip(self):
        for c in (self.a, self.b, self.a.merge(self.b)):
            self.assertEqual(CausalContext.from_json(c.to_json()), c)


if __name__ == "__main__":
    unittest.main()
