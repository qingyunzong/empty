import random
import unittest

from mincostflow import (
    Edge,
    MinCostCirculation,
    brute_force,
    verify_cut,
    verify_optimality,
)


def random_graph(rng, n_nodes=4, max_edges=6):
    nodes = [f"n{i}" for i in range(n_nodes)]
    edges = []
    for i in range(max_edges):
        u, v = rng.sample(nodes, 2)
        lo = rng.randint(0, 1)
        hi = lo + rng.randint(1, 4)
        cost = rng.randint(-5, 5)
        edges.append(Edge(f"e{i}", u, v, lo, hi, cost))
    demands = {v: 0 for v in nodes}
    # random balanced demands
    for _ in range(rng.randint(0, 2)):
        a, b = rng.sample(nodes, 2)
        delta = rng.randint(1, 2)
        demands[a] -= delta
        demands[b] += delta
    return nodes, edges, demands


class TestBruteForceOracle(unittest.TestCase):
    def test_random_small_graphs(self):
        rng = random.Random(12345)
        tested_feasible = 0
        tested_infeasible = 0
        for _ in range(200):
            nodes, edges, demands = random_graph(rng)
            feasible, min_cost, _ = brute_force(nodes, edges, demands)
            s = MinCostCirculation(nodes, edges, demands)
            r = s.solve()
            self.assertEqual(r.feasibility,
                             "feasible" if feasible else "infeasible")
            if feasible:
                tested_feasible += 1
                self.assertEqual(r.optimality, "optimal")
                self.assertEqual(r.cost, min_cost)
                self.assertTrue(
                    verify_optimality(nodes, edges, demands,
                                      r.flows, r.potentials),
                    msg=f"potentials rejected for {edges} {demands}")
            else:
                tested_infeasible += 1
                self.assertIsNotNone(r.certificate)
                self.assertTrue(
                    verify_cut(nodes, edges, demands, r.certificate),
                    msg=f"cut rejected for {edges} {demands}")
        # sanity: the fuzz actually covered both outcomes
        self.assertGreater(tested_feasible, 50)
        self.assertGreater(tested_infeasible, 10)

    def test_equal_cost_different_flows(self):
        # two disjoint paths S->T with identical unit cost: multiple optima
        nodes = ["S", "A", "B", "T"]
        edges = [
            Edge("p1", "S", "A", 0, 3, 1),
            Edge("p2", "A", "T", 0, 3, 1),
            Edge("q1", "S", "B", 0, 3, 1),
            Edge("q2", "B", "T", 0, 3, 1),
        ]
        demands = {"S": -2, "T": 2}
        feasible, min_cost, num_optima = brute_force(nodes, edges, demands)
        self.assertTrue(feasible)
        self.assertGreaterEqual(num_optima, 2)  # genuinely different optima
        s = MinCostCirculation(nodes, edges, demands)
        r = s.solve()
        self.assertEqual(r.optimality, "optimal")
        self.assertEqual(r.cost, min_cost)
        self.assertTrue(verify_optimality(nodes, edges, demands,
                                          r.flows, r.potentials))

    def test_negative_cycle_with_lower_bounds_and_demands(self):
        # combines negative cycle, fixed lower bounds and migrated demands
        nodes = ["X", "Y", "Z"]
        edges = [
            Edge("xy", "X", "Y", 1, 4, -2),
            Edge("yz", "Y", "Z", 1, 4, -1),
            Edge("zx", "Z", "X", 0, 4, 1),
            Edge("yx", "Y", "X", 0, 2, 3),
        ]
        demands = {"X": -1, "Z": 1}
        feasible, min_cost, _ = brute_force(nodes, edges, demands)
        self.assertTrue(feasible)
        s = MinCostCirculation(nodes, edges, demands)
        r = s.solve()
        self.assertEqual(r.optimality, "optimal")
        self.assertEqual(r.cost, min_cost)
        self.assertTrue(verify_optimality(nodes, edges, demands,
                                          r.flows, r.potentials))


if __name__ == "__main__":
    unittest.main()
