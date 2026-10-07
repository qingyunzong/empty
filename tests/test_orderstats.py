import random
import unittest
from fractions import Fraction

from mvview import OrderStats


class TestOrderStats(unittest.TestCase):
    def test_insert_select_rank_delete(self):
        os = OrderStats()
        for v in [5, 1, 9, 1, 7, 1]:
            os.insert(v)
        self.assertEqual(len(os), 6)
        self.assertEqual([os.select(k) for k in range(6)], [1, 1, 1, 5, 7, 9])
        self.assertEqual(os.rank(1), 0)
        self.assertEqual(os.rank(5), 3)
        self.assertEqual(os.rank(100), 6)
        os.delete(1)
        os.delete(1)
        self.assertEqual([os.select(k) for k in range(4)], [1, 5, 7, 9])
        os.delete(1)
        self.assertEqual(len(os), 3)
        with self.assertRaises(KeyError):
            os.delete(1)

    def test_fractions_and_multiplicity(self):
        os = OrderStats()
        os.insert(Fraction(1, 3), 3)
        os.insert(Fraction(1, 2), 2)
        self.assertEqual(len(os), 5)
        self.assertEqual(os.select(2), Fraction(1, 3))
        self.assertEqual(os.select(3), Fraction(1, 2))
        self.assertEqual(os.rank(Fraction(1, 2)), 3)
        os.delete(Fraction(1, 3), 3)
        self.assertEqual(len(os), 2)

    def test_randomized_vs_sorted_list(self):
        rng = random.Random(20261008)
        for _ in range(30):
            os = OrderStats()
            ref = []
            for _ in range(300):
                if ref and rng.random() < 0.45:
                    v = rng.choice(ref)
                    ref.remove(v)
                    os.delete(v)
                else:
                    v = Fraction(rng.randint(-50, 50), rng.randint(1, 7))
                    ref.append(v)
                    os.insert(v)
                self.assertEqual(len(os), len(ref))
            ref.sort()
            for k, v in enumerate(ref):
                self.assertEqual(os.select(k), v)
            for probe in [Fraction(-60), Fraction(0), Fraction(60)] + ref[:5]:
                self.assertEqual(os.rank(probe), sum(1 for x in ref if x < probe))


if __name__ == "__main__":
    unittest.main()
