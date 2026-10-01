import unittest

from budget_auth import solver
from budget_auth.system import Budget


def budgets(*specs):
    return {bid: Budget(bid, quota, parent) for bid, quota, parent in specs}


class SolverTest(unittest.TestCase):
    def test_single_budget_greedy(self):
        bs = budgets(("b1", 10, None))
        used = solver.compute_used(bs, [])
        self.assertEqual(solver.allocate(bs, used, ["b1"], 7), {"b1": 7})
        self.assertIsNone(solver.allocate(bs, used, ["b1"], 11))

    def test_min_budget_count_preferred(self):
        bs = budgets(("b1", 10, None), ("b2", 10, None))
        used = solver.compute_used(bs, [])
        # 8 fits in one budget: no split even though two exist.
        self.assertEqual(solver.allocate(bs, used, ["b1", "b2"], 8),
                         {"b1": 8})

    def test_id_order_tie_break(self):
        bs = budgets(("b2", 10, None), ("b1", 10, None))
        used = solver.compute_used(bs, [])
        self.assertEqual(solver.allocate(bs, used, ["b2", "b1"], 5),
                         {"b1": 5})

    def test_split_across_budgets(self):
        bs = budgets(("b1", 10, None), ("b2", 10, None))
        used = solver.compute_used(bs, [])
        self.assertEqual(solver.allocate(bs, used, ["b1", "b2"], 15),
                         {"b1": 10, "b2": 5})

    def test_shared_parent_capacity(self):
        bs = budgets(("p", 10, None), ("a", 10, "p"), ("b", 10, "p"))
        used = solver.compute_used(bs, [{"a": 6}])
        # parent has only 4 left for the whole subtree
        self.assertEqual(solver.allocate(bs, used, ["b"], 5), None)
        self.assertEqual(solver.allocate(bs, used, ["b"], 4), {"b": 4})

    def test_parent_counted_once_via_multiple_paths(self):
        # hold on a leaf charges each ancestor exactly once
        bs = budgets(("p", 10, None), ("a", 8, "p"), ("c", 5, "a"))
        used = solver.compute_used(bs, [{"c": 5}])
        self.assertEqual(used, {"p": 5, "a": 5, "c": 5})

    def test_nested_split_respects_ancestors(self):
        bs = budgets(("p", 12, None), ("a", 10, "p"), ("b", 10, "p"))
        used = solver.compute_used(bs, [])
        # parent caps the subtree total at 12
        self.assertEqual(solver.allocate(bs, used, ["a", "b"], 12),
                         {"a": 10, "b": 2})
        self.assertIsNone(solver.allocate(bs, used, ["a", "b"], 15))

    def test_diagnose_unsat_certificate(self):
        bs = budgets(("p", 10, None), ("a", 8, "p"))
        used = solver.compute_used(bs, [{"a": 3}])
        diag = solver.diagnose(bs, used, ["a"], 9)
        self.assertEqual(diag["requested"], 9)
        self.assertEqual(diag["allocatable"], 5)
        self.assertEqual(diag["deficit"], 4)
        by_id = {c["budget"]: c for c in diag["constraints"]}
        self.assertEqual(by_id["a"],
                         {"budget": "a", "quota": 8, "used": 3,
                          "available": 5})
        self.assertEqual(by_id["p"],
                         {"budget": "p", "quota": 10, "used": 3,
                          "available": 7})
        # verifiable: sum of leaf availability bounds the allocatable total
        self.assertLess(diag["allocatable"], diag["requested"])

    def test_max_allocatable(self):
        bs = budgets(("p", 9, None), ("a", 100, "p"), ("b", 100, "p"))
        used = solver.compute_used(bs, [])
        self.assertEqual(solver.max_allocatable(bs, used, ["a", "b"]), 9)


if __name__ == "__main__":
    unittest.main()
