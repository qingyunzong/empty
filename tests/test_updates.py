import unittest

from mincostflow import UpdateError, verify

from support import make_solver


def diamond():
    demands = {"s": -5, "a": 0, "t": 5}
    edges = [
        {"id": "direct", "tail": "s", "head": "t", "lower": 0,
         "upper": 5, "cost": 1},
        {"id": "up", "tail": "s", "head": "a", "lower": 0,
         "upper": 5, "cost": 1},
        {"id": "down", "tail": "a", "head": "t", "lower": 0,
         "upper": 5, "cost": 1},
    ]
    return demands, edges


class TestIncrementalUpdates(unittest.TestCase):
    def test_capacity_decrease_repairs_along_residual(self):
        demands, edges = diamond()
        solver = make_solver(demands, edges)
        first = solver.solve()
        self.assertEqual(first.flow["direct"], 5)
        self.assertEqual(first.cost, 5)

        # Capacity drops below the current flow: the excess must be
        # rerouted through the residual network, not rebuilt from scratch.
        solver.apply_updates([
            {"op": "set_bounds", "edge": "direct", "lower": 0, "upper": 2}])
        repaired = solver.solve()
        self.assertTrue(repaired.feasible)
        self.assertEqual(repaired.flow["direct"], 2)
        self.assertEqual(repaired.flow["up"], 3)
        self.assertEqual(repaired.flow["down"], 3)
        self.assertEqual(repaired.cost, 8)

        # The incremental repair matches a from-scratch solve.
        fresh_edges = [dict(e, upper=2) if e["id"] == "direct" else e
                       for e in edges]
        fresh = make_solver(demands, fresh_edges).solve()
        self.assertEqual(repaired.cost, fresh.cost)

    def test_simultaneous_demand_migration(self):
        demands = {"a": -4, "b": 2, "c": 2}
        edges = [
            {"id": "ab", "tail": "a", "head": "b", "lower": 0,
             "upper": 5, "cost": 1},
            {"id": "ac", "tail": "a", "head": "c", "lower": 0,
             "upper": 5, "cost": 3},
            {"id": "bc", "tail": "b", "head": "c", "lower": 0,
             "upper": 5, "cost": 1},
        ]
        solver = make_solver(demands, edges)
        self.assertTrue(solver.solve().feasible)

        # Move all demand from b to c in a single batch.
        solver.apply_updates([
            {"op": "set_demand", "node": "b", "demand": 0},
            {"op": "set_demand", "node": "c", "demand": 4},
        ])
        result = solver.solve()
        self.assertTrue(result.optimal)
        self.assertEqual(result.cost, 8)  # 4 units via a->b->c

        new_demands = {"a": -4, "b": 0, "c": 4}
        fresh = make_solver(new_demands, edges).solve()
        self.assertEqual(result.cost, fresh.cost)
        self.assertEqual(verify.check_optimality(
            new_demands, edges, result.flow, result.potentials), [])

    def test_cost_change_reoptimises_from_current_flow(self):
        demands = {"s": -2, "t": 2}
        edges = [
            {"id": "e1", "tail": "s", "head": "t", "lower": 0,
             "upper": 2, "cost": 1},
            {"id": "e2", "tail": "s", "head": "t", "lower": 0,
             "upper": 2, "cost": 5},
        ]
        solver = make_solver(demands, edges)
        first = solver.solve()
        self.assertEqual(first.flow, {"e1": 2, "e2": 0})

        solver.apply_updates([
            {"op": "set_cost", "edge": "e1", "cost": 10},
            {"op": "set_cost", "edge": "e2", "cost": 2},
        ])
        result = solver.solve()
        self.assertTrue(result.optimal)
        self.assertEqual(result.flow, {"e1": 0, "e2": 2})
        fresh_edges = [dict(e, cost=10) if e["id"] == "e1"
                       else dict(e, cost=2) for e in edges]
        self.assertEqual(result.cost,
                         make_solver(demands, fresh_edges).solve().cost)

    def test_cutting_critical_edge_keeps_published_version(self):
        demands, edges = diamond()
        solver = make_solver(demands, edges)
        first = solver.solve()
        self.assertTrue(first.optimal)

        # Sever every edge out of s: the model becomes infeasible.
        solver.apply_updates([
            {"op": "set_bounds", "edge": "direct", "lower": 0, "upper": 0},
            {"op": "set_bounds", "edge": "up", "lower": 0, "upper": 0},
        ])
        result = solver.solve()
        self.assertFalse(result.feasible)
        self.assertFalse(result.optimal)

        cut_edges = [dict(e, upper=0) for e in edges]
        self.assertEqual(verify.check_cut_certificate(
            demands, cut_edges, result.certificate), [])

        # The last published feasible version is still available.
        self.assertIsNotNone(solver.published)
        self.assertEqual(solver.published.flow, first.flow)
        self.assertEqual(solver.published.cost, first.cost)
        self.assertEqual(verify.check_optimality(
            demands, edges, solver.published.flow,
            solver.published.potentials), [])

    def test_pause_and_resume_optimisation(self):
        demands = {"a": 0, "b": 0, "c": 0, "d": 0}
        edges = [
            {"id": "e1", "tail": "a", "head": "b", "lower": 0,
             "upper": 5, "cost": -2},
            {"id": "e2", "tail": "b", "head": "a", "lower": 0,
             "upper": 5, "cost": 1},
            {"id": "e3", "tail": "c", "head": "d", "lower": 0,
             "upper": 5, "cost": -2},
            {"id": "e4", "tail": "d", "head": "c", "lower": 0,
             "upper": 5, "cost": 1},
        ]
        solver = make_solver(demands, edges)

        paused = solver.solve(budget=0)
        self.assertTrue(paused.feasible)
        self.assertFalse(paused.optimal)  # budget exhausted: not proven
        self.assertIsNone(paused.potentials)
        self.assertEqual(verify.check_flow(demands, edges, paused.flow), [])

        halfway = solver.solve(budget=1)
        self.assertTrue(halfway.feasible)
        self.assertFalse(halfway.optimal)

        done = solver.solve()
        self.assertTrue(done.optimal)
        self.assertEqual(done.cost, -10)
        fresh = make_solver(demands, edges).solve()
        self.assertEqual(done.cost, fresh.cost)

    def test_failed_transaction_changes_nothing(self):
        demands, edges = diamond()
        solver = make_solver(demands, edges)
        first = solver.solve()
        model_before = solver.model_dict()
        flow_before = dict(solver.flow)

        bad_batches = [
            [{"op": "set_cost", "edge": "direct", "cost": 9},
             {"op": "set_bounds", "edge": "up", "lower": 4, "upper": 2}],
            [{"op": "set_bounds", "edge": "ghost", "lower": 0, "upper": 1}],
            [{"op": "set_cost", "edge": "direct", "cost": 1.5}],
            [{"op": "set_demand", "node": "ghost", "demand": 1}],
            [{"op": "set_demand", "node": "a", "demand": True}],
            [{"op": "remove_edge", "edge": "ghost"}],
            [{"op": "teleport", "edge": "direct"}],
        ]
        for batch in bad_batches:
            with self.assertRaises(UpdateError):
                solver.apply_updates(batch)
            self.assertEqual(solver.model_dict(), model_before)
            self.assertEqual(solver.flow, flow_before)
            self.assertIsNotNone(solver.published)
            self.assertEqual(solver.published.flow, first.flow)

        # The solver is still fully usable afterwards.
        again = solver.solve()
        self.assertTrue(again.optimal)
        self.assertEqual(again.cost, first.cost)

    def test_equal_cost_alternative_optima(self):
        demands = {"a": -2, "b": 0, "c": 0, "d": 2}
        edges = [
            {"id": "ab", "tail": "a", "head": "b", "lower": 0,
             "upper": 2, "cost": 1},
            {"id": "bd", "tail": "b", "head": "d", "lower": 0,
             "upper": 2, "cost": 1},
            {"id": "ac", "tail": "a", "head": "c", "lower": 0,
             "upper": 2, "cost": 1},
            {"id": "cd", "tail": "c", "head": "d", "lower": 0,
             "upper": 2, "cost": 1},
        ]
        result = make_solver(demands, edges).solve()
        self.assertTrue(result.optimal)
        self.assertEqual(result.cost, 4)

        # A different but equally optimal flow is certified by the same
        # potentials.
        alternative = {"ab": 2, "bd": 2, "ac": 0, "cd": 0}
        if result.flow == alternative:
            alternative = {"ab": 0, "bd": 0, "ac": 2, "cd": 2}
        self.assertEqual(verify.check_optimality(
            demands, edges, alternative, result.potentials), [])


if __name__ == "__main__":
    unittest.main()
