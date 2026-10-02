import unittest

from mincostflow import MinCostCirculation, UpdateError, verify

from support import make_solver


class TestBasicSolving(unittest.TestCase):
    def test_simple_min_cost(self):
        demands = {"s": -3, "t": 3}
        edges = [
            {"id": "expensive", "tail": "s", "head": "t", "lower": 0,
             "upper": 3, "cost": 5},
            {"id": "cheap", "tail": "s", "head": "t", "lower": 0,
             "upper": 3, "cost": 1},
        ]
        result = make_solver(demands, edges).solve()
        self.assertTrue(result.feasible)
        self.assertTrue(result.optimal)
        self.assertEqual(result.flow["cheap"], 3)
        self.assertEqual(result.flow["expensive"], 0)
        self.assertEqual(result.cost, 3)
        self.assertEqual(verify.check_optimality(
            demands, edges, result.flow, result.potentials), [])

    def test_negative_cost_cycle_is_saturated(self):
        demands = {"a": 0, "b": 0}
        edges = [
            {"id": "e1", "tail": "a", "head": "b", "lower": 0,
             "upper": 5, "cost": -2},
            {"id": "e2", "tail": "b", "head": "a", "lower": 0,
             "upper": 5, "cost": 1},
        ]
        result = make_solver(demands, edges).solve()
        self.assertTrue(result.optimal)
        self.assertEqual(result.flow, {"e1": 5, "e2": 5})
        self.assertEqual(result.cost, -5)

    def test_lower_bounds_fix_the_flow(self):
        demands = {"a": -4, "b": 4}
        edges = [{"id": "e", "tail": "a", "head": "b", "lower": 4,
                  "upper": 4, "cost": 7}]
        result = make_solver(demands, edges).solve()
        self.assertTrue(result.optimal)
        self.assertEqual(result.flow["e"], 4)
        self.assertEqual(result.cost, 28)

    def test_lower_bound_without_matching_demand_is_infeasible(self):
        demands = {"a": 0, "b": 0}
        edges = [{"id": "e", "tail": "a", "head": "b", "lower": 4,
                  "upper": 4, "cost": 0}]
        result = make_solver(demands, edges).solve()
        self.assertFalse(result.feasible)
        self.assertFalse(result.optimal)
        self.assertEqual(verify.check_cut_certificate(
            demands, edges, result.certificate), [])

    def test_infeasible_demand_exceeds_capacity(self):
        demands = {"s": -5, "t": 5}
        edges = [{"id": "e", "tail": "s", "head": "t", "lower": 0,
                  "upper": 3, "cost": 1}]
        solver = make_solver(demands, edges)
        result = solver.solve()
        self.assertFalse(result.feasible)
        self.assertIsNone(result.flow)
        self.assertEqual(verify.check_cut_certificate(
            demands, edges, result.certificate), [])
        # No feasible version was ever published.
        self.assertIsNone(solver.published)

    def test_unbalanced_total_demand_is_infeasible(self):
        for demands in ({"a": 2, "b": 0}, {"a": -2, "b": 0}):
            edges = [{"id": "e", "tail": "a", "head": "b", "lower": 0,
                      "upper": 9, "cost": 1}]
            result = make_solver(demands, edges).solve()
            self.assertFalse(result.feasible)
            self.assertEqual(verify.check_cut_certificate(
                demands, edges, result.certificate), [])

    def test_duplicate_edge_id_rejected(self):
        solver = MinCostCirculation()
        solver.add_edge("e", "a", "b", 0, 1, 0)
        with self.assertRaises(UpdateError):
            solver.add_edge("e", "a", "b", 0, 1, 0)

    def test_invalid_bounds_rejected(self):
        solver = MinCostCirculation()
        with self.assertRaises(UpdateError):
            solver.add_edge("e", "a", "b", 3, 2, 0)
        with self.assertRaises(UpdateError):
            solver.add_edge("f", "a", "b", -1, 2, 0)
        with self.assertRaises(UpdateError):
            solver.add_edge("g", "a", "b", 0, 2, 1.5)


if __name__ == "__main__":
    unittest.main()
