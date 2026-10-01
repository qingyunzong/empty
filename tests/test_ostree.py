import bisect
import random
import unittest
from fractions import Fraction

from mvview import OrderStatTree


class OrderStatTreeRandomTest(unittest.TestCase):
    def test_randomized_against_sorted_list(self):
        rng = random.Random(20261001)
        tree = OrderStatTree()
        model = []
        for _ in range(4000):
            if model and rng.random() < 0.45:
                idx = rng.randrange(len(model))
                tree.remove(model[idx])
                model.pop(idx)
            else:
                value = Fraction(rng.randint(-30, 30), rng.choice([1, 1, 1, 2]))
                tree.insert(value)
                bisect.insort(model, value)
            self.assertEqual(len(tree), len(model))
            if model:
                k = rng.randrange(len(model))
                self.assertEqual(tree.select(k), model[k])
            probe = Fraction(rng.randint(-32, 32), rng.choice([1, 2]))
            self.assertEqual(tree.rank(probe), bisect.bisect_left(model, probe))
        while model:
            idx = rng.randrange(len(model))
            tree.remove(model[idx])
            model.pop(idx)
            self.assertEqual(len(tree), len(model))
        self.assertEqual(tree.to_list(), [])

    def test_bulk_duplicates(self):
        rng = random.Random(7)
        tree = OrderStatTree()
        model = []
        for _ in range(500):
            value = rng.randint(0, 5)
            for _ in range(rng.randint(1, 4)):
                tree.insert(value)
                bisect.insort(model, value)
        self.assertEqual(tree.to_list(), model)
        for k in range(len(model)):
            self.assertEqual(tree.select(k), model[k])


class OrderStatTreeBoundaryTest(unittest.TestCase):
    def test_empty_tree(self):
        tree = OrderStatTree()
        self.assertEqual(len(tree), 0)
        self.assertEqual(tree.rank(5), 0)
        with self.assertRaises(IndexError):
            tree.select(0)
        with self.assertRaises(KeyError):
            tree.remove(1)

    def test_multiplicity_semantics(self):
        tree = OrderStatTree()
        tree.insert(1)
        tree.insert(1)
        tree.insert(3)
        self.assertEqual(tree.count_of(1), 2)
        self.assertEqual(tree.select(0), 1)
        self.assertEqual(tree.select(1), 1)
        self.assertEqual(tree.select(2), 3)
        self.assertEqual(tree.rank(1), 0)
        self.assertEqual(tree.rank(2), 2)
        self.assertEqual(tree.rank(3), 2)
        self.assertEqual(tree.rank(4), 3)
        tree.remove(1)
        tree.remove(1)
        self.assertNotIn(1, tree)
        self.assertEqual(tree.to_list(), [3])
        with self.assertRaises(KeyError):
            tree.remove(1)


if __name__ == "__main__":
    unittest.main()
