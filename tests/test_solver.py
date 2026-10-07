import unittest

from mincostflow import (
    Edge,
    MinCostCirculation,
    brute_force,
    verify_cut,
    verify_flow,
    verify_optimality,
)


class TestBasicSolve(unittest.TestCase):
    def test_simple_optimal(self):
        edges = [
            Edge("e1", "A", "B", 0, 5, 2),
            Edge("e2", "A", "C", 0, 5, 1),
            Edge("e3", "C", "B", 0, 4, 0),
        ]
        demands = {"A": -4, "B": 4}
        s = MinCostCirculation(["A", "B", "C"], edges, demands)
        r = s.solve()
        self.assertEqual(r.feasibility, "feasible")
        self.assertEqual(r.optimality, "optimal")
        # path A->C->B costs 1/unit up to 4, so all 4 units go that way
        self.assertEqual(r.cost, 4)
        self.assertEqual(r.flows["e2"], 4)
        self.assertEqual(r.flows["e3"], 4)
        self.assertTrue(verify_optimality(["A", "B", "C"], edges, demands,
                                          r.flows, r.potentials))

    def test_negative_cost_cycle(self):
        # zero demands; the negative cycle must be saturated
        edges = [
            Edge("a", "X", "Y", 0, 4, -3),
            Edge("b", "Y", "X", 0, 4, 1),
            Edge("c", "X", "Y", 0, 2, 5),
        ]
        s = MinCostCirculation(["X", "Y"], edges, {})
        r = s.solve()
        self.assertEqual(r.optimality, "optimal")
        self.assertEqual(r.cost, -8)  # 4 units around the -2 cycle
        self.assertEqual(r.flows["a"], 4)
        self.assertEqual(r.flows["b"], 4)
        self.assertEqual(r.flows["c"], 0)
        self.assertTrue(verify_optimality(["X", "Y"], edges, {}, r.flows,
                                          r.potentials))
        self.assertEqual(brute_force(["X", "Y"], edges, {})[1], -8)

    def test_lower_bound_fixed_flow(self):
        # lo == hi forces the flow regardless of cost
        edges = [
            Edge("fix", "A", "B", 3, 3, 100),
            Edge("ret", "B", "A", 0, 10, 1),
        ]
        s = MinCostCirculation(["A", "B"], edges, {})
        r = s.solve()
        self.assertEqual(r.feasibility, "feasible")
        self.assertEqual(r.flows["fix"], 3)
        self.assertEqual(r.flows["ret"], 3)  # balance return flow
        self.assertEqual(r.cost, 303)
        self.assertTrue(verify_optimality(["A", "B"], edges, {}, r.flows,
                                          r.potentials))

    def test_infeasible_cut_certificate(self):
        edges = [Edge("e1", "A", "B", 0, 2, 1)]
        demands = {"A": -5, "B": 5}
        s = MinCostCirculation(["A", "B"], edges, demands)
        r = s.solve()
        self.assertEqual(r.feasibility, "infeasible")
        self.assertEqual(r.optimality, "infeasible")
        self.assertIsNotNone(r.certificate)
        self.assertTrue(verify_cut(["A", "B"], edges, demands, r.certificate))
        # nothing feasible gets published
        self.assertIsNone(s.published_result())

    def test_lower_bound_makes_infeasible(self):
        # forced 4 units A->B but return capacity only 2
        edges = [
            Edge("fix", "A", "B", 4, 4, 0),
            Edge("ret", "B", "A", 0, 2, 0),
        ]
        s = MinCostCirculation(["A", "B"], edges, {})
        r = s.solve()
        self.assertEqual(r.feasibility, "infeasible")
        self.assertTrue(verify_cut(["A", "B"], edges, {}, r.certificate))

    def test_duplicate_edge_id_rejected(self):
        with self.assertRaises(ValueError):
            MinCostCirculation(["A", "B"],
                               [Edge("e", "A", "B", 0, 1, 0),
                                Edge("e", "A", "B", 0, 1, 0)], {})

    def test_unbalanced_demands_rejected(self):
        with self.assertRaises(ValueError):
            MinCostCirculation(["A", "B"], [], {"A": 1, "B": 0})

    def test_budget_exhausted_is_feasible_not_optimal(self):
        edges = [
            Edge("a", "X", "Y", 0, 10, -3),
            Edge("b", "Y", "X", 0, 10, 1),
        ]
        s = MinCostCirculation(["X", "Y"], edges, {})
        r = s.solve(budget=1)  # one BF pass: finds a cycle but cannot re-check
        self.assertEqual(r.feasibility, "feasible")
        self.assertEqual(r.optimality, "not_proven")
        self.assertIsNone(r.potentials)
        self.assertTrue(verify_flow(["X", "Y"], edges, {}, r.flows))
        # published version must also be marked not_proven, never optimal
        self.assertEqual(s.published_result().optimality, "not_proven")

    def test_pause_and_resume(self):
        edges = [
            Edge("a", "X", "Y", 0, 10, -3),
            Edge("b", "Y", "Z", 0, 10, -2),
            Edge("c", "Z", "X", 0, 10, 1),
            Edge("d", "X", "Z", 0, 3, 4),
        ]
        one_shot = MinCostCirculation(["X", "Y", "Z"], edges, {})
        final = one_shot.solve()
        self.assertEqual(final.optimality, "optimal")

        paused = MinCostCirculation(["X", "Y", "Z"], edges, {})
        r = paused.solve(budget=1)
        self.assertEqual(r.optimality, "not_proven")
        # resume with more budget until proven optimal
        for _ in range(50):
            r = paused.solve(budget=1)
            if r.optimality == "optimal":
                break
        self.assertEqual(r.optimality, "optimal")
        self.assertEqual(r.cost, final.cost)
        self.assertTrue(verify_optimality(["X", "Y", "Z"], edges, {},
                                          r.flows, r.potentials))


if __name__ == "__main__":
    unittest.main()
