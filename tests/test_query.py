import random
import unittest

from rknni import Index, verify

from helpers import brute_force, make_index, random_vector

ALL_FILTERS = [
    None,
    {"tag": "a"},
    {"tag": "b"},
    {"tag": "c"},
    {"tag": "missing"},
    {"not": {"tag": "a"}},
    {"not": {"tag": "b"}},
    {"and": [{"tag": "a"}, {"tag": "b"}]},
    {"and": [{"tag": "a"}, {"not": {"tag": "b"}}]},
    {"or": [{"tag": "a"}, {"tag": "c"}]},
    {"or": [{"tag": "missing"}, {"tag": "b"}]},
    {"and": [{"or": [{"tag": "a"}, {"tag": "b"}]}, {"not": {"tag": "c"}}]},
    {"not": {"or": [{"tag": "a"}, {"tag": "b"}]}},
    {"and": [{"tag": "a"}, {"tag": "b"}, {"tag": "c"}]},
    {"not": {"not": {"tag": "a"}}},
]


class TestBruteForceCrosscheck(unittest.TestCase):
    """Every filter combination, several sizes and K values, vs full scan."""

    def test_all_filter_combinations(self):
        rng = random.Random(20240201)
        for n in (0, 1, 5, 30, 80):
            idx = make_index(rng, n, dim=3, capacity=5, fanout=5)
            points = idx.points()
            for _ in range(3):
                q = random_vector(rng, 3)
                for filt in ALL_FILTERS:
                    for k in (1, 2, 3, 7, 100):
                        res = idx.query(q, k, filter=filt)
                        self.assertEqual(
                            res.status, "exact",
                            f"n={n} k={k} filter={filt} not exact",
                        )
                        self.assertEqual(
                            res.items,
                            brute_force(points, q, k, filt),
                            f"n={n} k={k} filter={filt}",
                        )
                        self.assertTrue(verify(points, q, k, filt, res))

    def test_crosscheck_after_deletes(self):
        rng = random.Random(20240202)
        idx = make_index(rng, 90, dim=2, capacity=4, fanout=4)
        for i in range(0, 90, 3):
            idx.delete(i)
        points = idx.points()
        for filt in ALL_FILTERS:
            q = random_vector(rng, 2)
            res = idx.query(q, 6, filter=filt)
            self.assertEqual(res.items, brute_force(points, q, 6, filt))
            self.assertTrue(verify(points, q, 6, filt, res))


class TestBoundaryTiesAndDuplicates(unittest.TestCase):
    def test_equidistant_points_ordered_by_id(self):
        idx = Index(2, capacity=2, fanout=2)
        idx.insert(4, [1, 0])
        idx.insert(2, [0, 1])
        idx.insert(3, [-1, 0])
        idx.insert(1, [0, -1])
        idx.insert(0, [2, 0])  # dist 4, id smallest
        res = idx.query([0, 0], 4)
        self.assertEqual([pid for pid, _ in res.items], [1, 2, 3, 4])
        self.assertTrue(all(str(d) == "1" for _, d in res.items))
        res5 = idx.query([0, 0], 5)
        self.assertEqual([pid for pid, _ in res5.items], [1, 2, 3, 4, 0])
        self.assertTrue(verify(idx.points(), [0, 0], 5, None, res5))

    def test_tie_across_leaves_not_pruned(self):
        # Two points on opposite sides of the query, equal distance,
        # forced into different leaves; strict '>' pruning must keep both.
        idx = Index(1, capacity=2, fanout=2)
        idx.insert("left", [-2])
        idx.insert("right", [2])
        for i in range(6):
            idx.insert(f"far{i}", [100 + i])
        res = idx.query([0], 2)
        self.assertEqual([pid for pid, _ in res.items], ["left", "right"])
        self.assertTrue(verify(idx.points(), [0], 2, None, res))

    def test_duplicate_coordinates(self):
        idx = Index(2, capacity=3, fanout=3)
        for pid in (10, 11, 12, 13):
            idx.insert(pid, [5, 5])
        idx.insert(1, [6, 5])
        res = idx.query([5, 5], 3)
        self.assertEqual([pid for pid, _ in res.items], [10, 11, 12])
        self.assertTrue(all(str(d) == "0" for _, d in res.items))
        res_all = idx.query([5, 5], 5)
        self.assertEqual([pid for pid, _ in res_all.items], [10, 11, 12, 13, 1])
        self.assertTrue(verify(idx.points(), [5, 5], 5, None, res_all))


class TestHugeScores(unittest.TestCase):
    def test_exact_order_beyond_float_precision(self):
        base = 10**18
        idx = Index(1, capacity=4)
        idx.insert("a", [base])
        idx.insert("b", [base + 1])
        idx.insert("c", [-base])
        idx.insert("d", [base + 2])
        res = idx.query([0], 4)
        # a and c tie at 10**36; b is 2*10**18+1 further (invisible in float).
        self.assertEqual([pid for pid, _ in res.items], ["a", "c", "b", "d"])
        self.assertEqual(str(res.items[2][1] - res.items[0][1]),
                         str(2 * base + 1))
        self.assertTrue(verify(idx.points(), [0], 4, None, res))

    def test_huge_rationals(self):
        idx = Index(2, capacity=4)
        idx.insert("x", ["123456789012345678901234567890/7", "1/3"])
        idx.insert("y", ["123456789012345678901234567891/7", "1/3"])
        res = idx.query([0, 0], 1)
        self.assertEqual(res.items[0][0], "x")
        self.assertTrue(verify(idx.points(), [0, 0], 1, None, res))


class TestBudgetAndCertificates(unittest.TestCase):
    def setUp(self):
        rng = random.Random(31337)
        self.idx = make_index(rng, 120, dim=2, capacity=4, fanout=4)
        self.q = [3, -2]

    def test_zero_budget_is_partial_not_exact(self):
        res = self.idx.query(self.q, 5, budget=0)
        self.assertEqual(res.status, "partial")
        self.assertFalse(res.complete)
        self.assertEqual(res.items, [])
        self.assertEqual(res.stats["visited_nodes"], 0)
        self.assertGreaterEqual(len(res.cert_entries), 1)
        # A partial (unknown) result must still pass coverage verification.
        self.assertTrue(verify(self.idx.points(), self.q, 5, None, res))

    def test_zero_budget_on_empty_index_is_exact(self):
        res = Index(2).query([0, 0], 5, budget=0)
        self.assertEqual(res.status, "exact")
        self.assertEqual(res.items, [])

    def test_small_budget_partial_and_verifiable(self):
        res = self.idx.query(self.q, 5, budget=2)
        self.assertEqual(res.status, "partial")
        self.assertLessEqual(len(res.items), 5)
        self.assertGreater(len(res.cert_entries), 0)
        self.assertTrue(verify(self.idx.points(), self.q, 5, None, res))

    def test_budget_exactly_sufficient_is_exact(self):
        full = self.idx.query(self.q, 5)
        needed = full.stats["visited_nodes"]
        res = self.idx.query(self.q, 5, budget=needed)
        self.assertEqual(res.status, "exact")
        self.assertEqual(res.items, full.items)

    def test_certificate_bounds_exceed_kth_distance(self):
        res = self.idx.query(self.q, 4)
        self.assertEqual(res.status, "exact")
        self.assertGreater(len(res.cert_entries), 0)
        worst = res.items[-1][1]
        for entry in res.cert_entries:
            self.assertGreater(entry["bound"], worst)

    def test_k_greater_than_hits(self):
        filt = {"tag": "definitely-not-present"}
        res = self.idx.query(self.q, 10, filter=filt)
        self.assertEqual(res.status, "exact")
        self.assertEqual(res.items, [])
        self.assertEqual(res.cert_entries, [])
        self.assertTrue(verify(self.idx.points(), self.q, 10, filt, res))

    def test_k_greater_than_matching_subset(self):
        idx = Index(2, capacity=4)
        for i in range(30):
            idx.insert(f"p{i}", [i, 0], tags=["even"] if i % 2 == 0 else [])
        filt = {"and": [{"tag": "even"}, {"not": {"tag": "even"}}]}
        res = idx.query([0, 0], 10, filter=filt)
        self.assertEqual(res.items, [])
        filt2 = {"tag": "even"}
        res2 = idx.query([0, 0], 100, filter=filt2)
        self.assertEqual(len(res2.items), 15)
        self.assertEqual(res2.status, "exact")
        self.assertTrue(verify(idx.points(), [0, 0], 100, filt2, res2))

    def test_k_zero(self):
        res = self.idx.query(self.q, 0)
        self.assertEqual(res.status, "exact")
        self.assertEqual(res.items, [])
        self.assertTrue(verify(self.idx.points(), self.q, 0, None, res))

    def test_invalid_arguments(self):
        with self.assertRaises(ValueError):
            self.idx.query(self.q, -1)
        with self.assertRaises(ValueError):
            self.idx.query(self.q, 3, budget=-1)
        with self.assertRaises(ValueError):
            self.idx.query(self.q, 3, filter={"bogus": 1})
        from rknni import DimensionError
        with self.assertRaises(DimensionError):
            self.idx.query([1, 2, 3], 3)


if __name__ == "__main__":
    unittest.main()
