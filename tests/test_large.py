"""Large-sample tests: real visited-node counts and pruning effectiveness."""

import random
import unittest

from rknni import Index, verify

from helpers import brute_force, random_vector


class TestLargeSample(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.n = 3000
        cls.dim = 6
        rng = random.Random(20240601)
        cls.idx = Index(cls.dim, capacity=8, fanout=8)
        tags = [f"t{i}" for i in range(10)]
        for i in range(cls.n):
            point_tags = [t for t in tags if rng.random() < 0.15]
            cls.idx.insert(i, random_vector(rng, cls.dim), tags=point_tags, version=1)
        cls.points = cls.idx.points()

    def test_unfiltered_exact_with_visit_report(self):
        q = [0] * self.dim
        k = 10
        res = self.idx.query(q, k)
        total = self.idx.total_nodes()
        stats = res.stats
        print(
            f"\n[large/unfiltered] n={self.n} dim={self.dim} k={k} "
            f"status={res.status} visited_nodes={stats['visited_nodes']}/{total} "
            f"point_evals={stats['point_evals']}/{self.n} "
            f"distance_pruned={stats['distance_pruned']}"
        )
        self.assertEqual(res.status, "exact")
        self.assertEqual(res.items, brute_force(self.points, q, k))
        self.assertTrue(verify(self.points, q, k, None, res))
        # Branch-and-bound must actually prune on this sample.
        self.assertLess(stats["visited_nodes"], total)
        self.assertLess(stats["point_evals"], self.n)

    def test_filtered_exact_with_visit_report(self):
        q = [3, -2, 1, 0, 5, -4]
        k = 8
        filt = {"and": [{"or": [{"tag": "t1"}, {"tag": "t3"}]},
                        {"not": {"tag": "t7"}}]}
        res = self.idx.query(q, k, filter=filt)
        total = self.idx.total_nodes()
        stats = res.stats
        print(
            f"\n[large/filtered] n={self.n} dim={self.dim} k={k} "
            f"status={res.status} visited_nodes={stats['visited_nodes']}/{total} "
            f"point_evals={stats['point_evals']}/{self.n} "
            f"filter_pruned={stats['filter_pruned']} "
            f"distance_pruned={stats['distance_pruned']}"
        )
        self.assertEqual(res.status, "exact")
        self.assertEqual(res.items, brute_force(self.points, q, k, filt))
        self.assertTrue(verify(self.points, q, k, filt, res))
        self.assertLess(stats["visited_nodes"], total)

    def test_partial_budget_report(self):
        q = [1] * self.dim
        k = 10
        full = self.idx.query(q, k)
        half = max(1, full.stats["visited_nodes"] // 2)
        res = self.idx.query(q, k, budget=half)
        print(
            f"\n[large/budget={half}] status={res.status} "
            f"returned={len(res.items)}/{k} "
            f"cert_entries={len(res.cert_entries)} "
            f"visited_nodes={res.stats['visited_nodes']}"
        )
        self.assertEqual(res.status, "partial")
        self.assertFalse(res.complete)
        self.assertTrue(verify(self.points, q, k, None, res))


if __name__ == "__main__":
    unittest.main()
