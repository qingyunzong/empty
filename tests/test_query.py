import random
import unittest
from fractions import Fraction

from knnindex import KNNIndex, brute_force
from knnindex.geometry import to_point
from knnindex.tree import iter_entries

from tests.test_filters import all_filter_expressions


def random_index(n, dims, seed, label_pool=("a", "b")):
    rng = random.Random(seed)
    idx = KNNIndex(dims)
    for i in range(n):
        coords = [Fraction(rng.randint(-20, 20), rng.choice([1, 1, 2, 3])) for _ in range(dims)]
        labels = {t for t in label_pool if rng.random() < 0.5}
        idx.insert(f"p{i}", coords, labels)
    return idx, rng


class TestBruteForceCrossCheck(unittest.TestCase):
    """Small data: every filter combination checked against an independent scan."""

    def check_all_filters(self, idx, q, k):
        entries = list(iter_entries(idx._root))
        for expr in all_filter_expressions():
            result = idx.query(q, k, expr)
            truth = brute_force(entries, to_point(q), k, expr)
            self.assertEqual(result.status, "complete")
            self.assertEqual(
                result.hits, truth, f"filter {expr}: index {result.hits} != scan {truth}"
            )

    def test_all_filter_combinations_small(self):
        idx, rng = random_index(60, 2, seed=11)
        for trial in range(5):
            q = [Fraction(rng.randint(-20, 20)), Fraction(rng.randint(-20, 20))]
            for k in (1, 3, 7, 20):
                self.check_all_filters(idx, q, k)

    def test_all_filter_combinations_3d(self):
        idx, rng = random_index(45, 3, seed=12)
        q = [Fraction(1, 2), Fraction(-3, 2), Fraction(7, 3)]
        for k in (1, 5, 100):
            self.check_all_filters(idx, q, k)

    def test_mutations_then_crosscheck(self):
        idx, rng = random_index(50, 2, seed=13)
        for i in range(0, 50, 3):
            idx.delete(f"p{i}")
        for i in range(10):
            idx.replace(f"p{i * 3 + 1}", [rng.randint(-5, 5), rng.randint(-5, 5)],
                        {"a"} if i % 2 else set())
        for i in range(10):
            idx.insert(f"new{i}", [rng.randint(-20, 20)] * 2, {"b"})
        self.check_all_filters(idx, [0, 0], 6)


class TestEdgeCases(unittest.TestCase):
    def test_boundary_ties_broken_by_id(self):
        idx = KNNIndex(2)
        # four points exactly equidistant (dist2 = 25) from the origin
        idx.insert("d", [3, 4])
        idx.insert("b", [-3, 4])
        idx.insert("a", [4, 3])
        idx.insert("c", [0, 5])
        idx.insert("z", [100, 100])
        result = idx.query([0, 0], 4)
        self.assertEqual(result.status, "complete")
        self.assertEqual([pid for _, pid in result.hits], ["a", "b", "c", "d"])
        self.assertTrue(all(d == 25 for d, _ in result.hits))
        # k=3 must return the first three ids of the tied group, exactly
        self.assertEqual([pid for _, pid in idx.query([0, 0], 3).hits], ["a", "b", "c"])

    def test_tie_at_kth_boundary_does_not_lose_competitors(self):
        idx = KNNIndex(1)
        for i in range(9):
            idx.insert(f"p{i}", [10])  # nine identical tied points
        idx.insert("near", [1])
        result = idx.query([0], 5)
        self.assertEqual(result.status, "complete")
        self.assertEqual(
            result.hits,
            [(Fraction(1), "near")] + [(Fraction(100), f"p{i}") for i in range(4)],
        )

    def test_k_greater_than_hits(self):
        idx = KNNIndex(2)
        idx.insert("a", [0, 0], ["x"])
        idx.insert("b", [1, 1])
        result = idx.query([0, 0], 10, {"tag": "x"})
        self.assertEqual(result.status, "complete")
        self.assertEqual(result.hits, [(Fraction(0), "a")])
        self.assertIsNone(result.kth_dist)  # fewer than k hits: no kth bound

    def test_zero_budget_is_honestly_unknown(self):
        idx, _ = random_index(30, 2, seed=21)
        result = idx.query([0, 0], 3, budget=0)
        self.assertEqual(result.status, "unknown")
        self.assertEqual(result.nodes_visited, 0)
        self.assertEqual(result.hits, [])
        self.assertTrue(result.certificates)
        self.assertTrue(all(c.reason == "budget" for c in result.certificates))
        # the certificate bound must be a genuine lower bound
        truth = brute_force(list(iter_entries(idx._root)), to_point([0, 0]), 3)
        self.assertLessEqual(min(c.bound for c in result.certificates), truth[-1][0])

    def test_budget_exhaustion_never_claims_exact(self):
        idx, _ = random_index(200, 2, seed=22)
        for budget in (1, 2, 3, 5, 8):
            result = idx.query([0, 0], 5, budget=budget)
            self.assertEqual(result.status, "unknown")
            self.assertLessEqual(result.nodes_visited, budget)
            self.assertTrue(result.resume_items)

    def test_empty_index_and_zero_k(self):
        idx = KNNIndex(2)
        self.assertEqual(idx.query([0, 0], 5).hits, [])
        idx.insert("a", [1, 1])
        self.assertEqual(idx.query([0, 0], 0).hits, [])

    def test_unknown_result_candidates_are_real(self):
        idx, _ = random_index(100, 2, seed=23)
        result = idx.query([0, 0], 5, budget=3)
        self.assertEqual(result.status, "unknown")
        entries = {e.point_id: e for e in iter_entries(idx._root)}
        for d, pid in result.hits:
            self.assertIn(pid, entries)
            from knnindex.geometry import dist2

            self.assertEqual(d, dist2(entries[pid].coords, to_point([0, 0])))


class TestLargeSampleStats(unittest.TestCase):
    def test_large_sample_reports_real_visit_counts(self):
        n = 3000
        idx, rng = random_index(n, 3, seed=99, label_pool=("a", "b", "c"))
        q = [Fraction(3, 2), Fraction(-7, 4), Fraction(11, 2)]

        full = idx.query(q, 10)
        truth = brute_force(list(iter_entries(idx._root)), to_point(q), 10)
        self.assertEqual(full.status, "complete")
        self.assertEqual(full.hits, truth)

        filtered = idx.query(q, 10, {"and": [{"tag": "a"}, {"not": {"tag": "b"}}]})
        truth_f = brute_force(
            list(iter_entries(idx._root)), to_point(q), 10,
            {"and": [{"tag": "a"}, {"not": {"tag": "b"}}]},
        )
        self.assertEqual(filtered.hits, truth_f)

        total_nodes = 2 * ((n + 7) // 8)  # loose upper bound on tree size
        print(f"\n[large-sample n={n}] unfiltered: visited {full.nodes_visited} nodes "
              f"({full.leaves_visited} leaves), certs={len(full.certificates)}")
        print(f"[large-sample n={n}] filtered:   visited {filtered.nodes_visited} nodes "
              f"({filtered.leaves_visited} leaves), certs={len(filtered.certificates)}")
        # branch-and-bound must visit far fewer nodes than a full scan of leaves
        self.assertLess(full.nodes_visited, n // 8)
        self.assertGreater(full.nodes_visited, 0)


if __name__ == "__main__":
    unittest.main()
