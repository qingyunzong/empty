import random
import unittest

from mincostflow import (
    Edge,
    MinCostCirculation,
    UpdateError,
    brute_force,
    verify_cut,
    verify_optimality,
)


def diamond():
    nodes = ["S", "P", "Q", "T"]
    edges = [
        Edge("sp", "S", "P", 0, 6, 1),
        Edge("sq", "S", "Q", 0, 6, 2),
        Edge("pt", "P", "T", 0, 6, 1),
        Edge("qt", "Q", "T", 0, 6, 1),
        Edge("pq", "P", "Q", 0, 3, 0),
    ]
    demands = {"S": -5, "T": 5}
    return nodes, edges, demands


class TestIncrementalRepair(unittest.TestCase):
    def test_demand_migration_single_batch(self):
        nodes, edges, demands = diamond()
        s = MinCostCirculation(nodes, edges, demands)
        r1 = s.solve()
        self.assertEqual(r1.optimality, "optimal")
        # migrate 3 units of demand from T to P in one atomic batch
        s.apply_updates(demand_updates={"T": 2, "P": 3})
        r2 = s.solve()
        self.assertEqual(r2.feasibility, "feasible")
        self.assertEqual(r2.optimality, "optimal")
        new_demands = {"S": -5, "T": 2, "P": 3}
        self.assertTrue(verify_optimality(nodes, edges, new_demands,
                                          r2.flows, r2.potentials))
        # matches a from-scratch solve
        fresh = MinCostCirculation(nodes, [Edge(**e.to_dict()) for e in edges],
                                   new_demands)
        self.assertEqual(r2.cost, fresh.solve().cost)

    def test_capacity_decrease_below_current_flow(self):
        nodes, edges, demands = diamond()
        s = MinCostCirculation(nodes, edges, demands)
        r1 = s.solve()
        self.assertEqual(r1.flows["sp"], 5)  # cheap path saturated
        # cut the cheap edge below the current flow: must reroute via residual
        s.apply_updates(edge_updates={"sp": {"hi": 2}})
        r2 = s.solve()
        self.assertEqual(r2.feasibility, "feasible")
        self.assertLessEqual(r2.flows["sp"], 2)
        new_edges = [Edge(**{**e.to_dict(), "hi": 2}) if e.id == "sp"
                     else Edge(**e.to_dict()) for e in edges]
        self.assertTrue(verify_optimality(nodes, new_edges, demands,
                                          r2.flows, r2.potentials))
        fresh = MinCostCirculation(nodes, new_edges, demands)
        self.assertEqual(r2.cost, fresh.solve().cost)

    def test_cut_critical_edge_infeasible_keeps_published(self):
        nodes, edges, demands = diamond()
        s = MinCostCirculation(nodes, edges, demands)
        r1 = s.solve()
        published_flows = dict(r1.flows)
        # sever both paths into T
        s.apply_updates(edge_updates={"pt": {"hi": 1}, "qt": {"hi": 1}})
        r2 = s.solve()
        self.assertEqual(r2.feasibility, "infeasible")
        cut_edges = [Edge(**{**e.to_dict(), "hi": 1}) if e.id in ("pt", "qt")
                     else Edge(**e.to_dict()) for e in edges]
        self.assertTrue(verify_cut(nodes, cut_edges, demands, r2.certificate))
        # last published feasible version is preserved
        pub = s.published_result()
        self.assertIsNotNone(pub)
        self.assertEqual(pub.flows, published_flows)
        self.assertEqual(pub.optimality, "optimal")

    def test_cost_change_keeps_flow_reoptimizes(self):
        nodes, edges, demands = diamond()
        s = MinCostCirculation(nodes, edges, demands)
        r1 = s.solve()
        # make the expensive path cheap; feasibility must be preserved
        s.apply_updates(edge_updates={"sq": {"cost": -5}})
        r2 = s.solve()
        self.assertEqual(r2.feasibility, "feasible")
        self.assertEqual(r2.optimality, "optimal")
        new_edges = [Edge(**{**e.to_dict(), "cost": -5}) if e.id == "sq"
                     else Edge(**e.to_dict()) for e in edges]
        self.assertTrue(verify_optimality(nodes, new_edges, demands,
                                          r2.flows, r2.potentials))
        fresh = MinCostCirculation(nodes, new_edges, demands)
        self.assertEqual(r2.cost, fresh.solve().cost)

    def test_transaction_error_changes_nothing(self):
        nodes, edges, demands = diamond()
        s = MinCostCirculation(nodes, edges, demands)
        s.solve()
        before = s.snapshot()
        bad_batches = [
            ({"nope": {"hi": 1}}, None),                       # unknown edge
            ({"sp": {"lo": 5, "hi": 2}}, None),                # lo > hi
            ({"sp": {"hi": "x"}}, None),                       # non-integer
            (None, {"T": 1}),                                  # demands unbalanced
            (None, {"ghost": 1}),                              # unknown node
            ({"sp": {"hi": 3}, "bad": {"lo": 0}}, None),       # mixed valid+invalid
        ]
        for edge_upd, dem_upd in bad_batches:
            with self.assertRaises(UpdateError):
                s.apply_updates(edge_updates=edge_upd, demand_updates=dem_upd)
            self.assertEqual(s.snapshot(), before)

    def test_random_update_sequences_match_fresh_solve(self):
        rng = random.Random(20261007)
        for trial in range(40):
            nodes = ["a", "b", "c", "d"]
            edges = []
            eid = 0
            for u in nodes:
                for v in nodes:
                    if u != v and rng.random() < 0.5:
                        lo = rng.randint(0, 1)
                        edges.append(Edge(f"e{eid}", u, v, lo,
                                          lo + rng.randint(0, 3),
                                          rng.randint(-4, 4)))
                        eid += 1
            if not edges:
                continue
            demands = {v: 0 for v in nodes}
            demands["a"] = -2
            demands["d"] = 2
            s = MinCostCirculation(nodes, [Edge(**e.to_dict()) for e in edges],
                                   dict(demands))
            s.solve()
            for _ in range(rng.randint(1, 4)):
                edge_upd = {}
                for e in rng.sample(edges, rng.randint(1, len(edges))):
                    lo = rng.randint(0, 1)
                    edge_upd[e.id] = {"lo": lo, "hi": lo + rng.randint(0, 3),
                                      "cost": rng.randint(-4, 4)}
                    e.lo, e.hi, e.cost = (edge_upd[e.id]["lo"],
                                          edge_upd[e.id]["hi"],
                                          edge_upd[e.id]["cost"])
                s.apply_updates(edge_updates=edge_upd)
            r = s.solve()
            fresh = MinCostCirculation(nodes, edges, demands)
            rf = fresh.solve()
            self.assertEqual(r.feasibility, rf.feasibility)
            if r.feasibility == "feasible":
                self.assertEqual(r.optimality, "optimal")
                self.assertEqual(r.cost, rf.cost)
                self.assertTrue(verify_optimality(nodes, edges, demands,
                                                  r.flows, r.potentials))
            else:
                self.assertTrue(verify_cut(nodes, edges, demands,
                                           r.certificate))


if __name__ == "__main__":
    unittest.main()
