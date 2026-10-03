import random
import unittest

from mcflow import Edge, Network, enumerate_optimal_repair, repair, verify
from helpers import cascade_network, diamond_network, l1_tiebreak_network


def random_network(rng, num_edges=5, max_cap=2):
    """Random feasible network: demands derived from a random feasible flow."""
    nodes = ["s", "a", "b", "t"]
    chain = [("s", "a"), ("a", "b"), ("b", "t"), ("s", "t"), ("a", "t"),
             ("s", "b")]
    edges = []
    for i in range(num_edges):
        tail, head = chain[i % len(chain)]
        edges.append(Edge(f"e{i}", tail, head, 0,
                          rng.randint(1, max_cap), rng.randint(-3, 5)))
    feasible = {e.id: rng.randint(e.lower, e.upper) for e in edges}
    demands = {v: 0 for v in nodes}
    for e in edges:
        demands[e.tail] -= feasible[e.id]
        demands[e.head] += feasible[e.id]
    return Network(nodes=nodes, edges=edges, demands=demands)


class BruteForceCrossCheckTest(unittest.TestCase):
    def assert_matches_bruteforce(self, network, base_flow):
        expected = enumerate_optimal_repair(network, base_flow)
        result = repair(network, base_flow)
        if expected["status"] == "infeasible":
            self.assertEqual(result.status, "infeasible")
            self.assertIsNotNone(result.cut)
            return
        self.assertEqual(result.status, "optimal")
        self.assertTrue(result.optimal)
        self.assertEqual(result.changed_edges, expected["changed_edges"])
        self.assertEqual(result.l1_distance, expected["l1_distance"])
        self.assertEqual(result.cost, expected["cost"])
        self.assertEqual(result.lower_bound_changes, expected["changed_edges"])
        # The repaired flow must itself be feasible under independent
        # verification (it need not be globally cost-optimal: feasibility
        # is only the third repair objective).
        cert = {"flows": result.flow,
                "potentials": {v: 0 for v in network.nodes},
                "declared_cost": result.cost}
        report = verify(network, cert)
        feasibility = [v for v in report.violations
                       if v["type"] in ("capacity", "conservation",
                                        "cost_mismatch", "missing_flow",
                                        "non_integer_flow")]
        self.assertEqual(feasibility, [])

    def test_fixed_networks(self):
        self.assert_matches_bruteforce(
            diamond_network(), {"e1": 3, "e2": 3, "e3": 0})
        self.assert_matches_bruteforce(
            diamond_network(), {"e1": 0, "e2": 0, "e3": 3})
        self.assert_matches_bruteforce(
            cascade_network(), {"e1": 3, "e2": 3, "e3": 3, "e4": 0})
        self.assert_matches_bruteforce(
            l1_tiebreak_network(), {"e1": 2, "e2": 2, "e4": 0})

    def test_random_networks(self):
        rng = random.Random(20261003)
        for _ in range(15):
            network = random_network(rng)
            base = {e.id: rng.randint(0, e.upper + 1) for e in network.edges}
            self.assert_matches_bruteforce(network, base)

    def test_enumeration_guard(self):
        edges = [Edge(f"e{i}", "s", "t", 0, 10, 1) for i in range(10)]
        network = Network(nodes=["s", "t"], edges=edges,
                          demands={"s": 0, "t": 0})
        with self.assertRaises(ValueError):
            enumerate_optimal_repair(network, {}, max_combinations=100)


if __name__ == "__main__":
    unittest.main()
