import unittest

from mincostflow import (
    Edge,
    MinCostCirculation,
    verify_cut,
    verify_flow,
    verify_optimality,
)


def solved():
    nodes = ["S", "A", "T"]
    edges = [
        Edge("sa", "S", "A", 0, 5, 1),
        Edge("at", "A", "T", 0, 5, 1),
        Edge("st", "S", "T", 0, 5, 5),
    ]
    demands = {"S": -3, "T": 3}
    s = MinCostCirculation(nodes, edges, demands)
    r = s.solve()
    assert r.optimality == "optimal"
    return nodes, edges, demands, r


class TestVerifier(unittest.TestCase):
    def test_valid_result_accepted(self):
        nodes, edges, demands, r = solved()
        self.assertTrue(verify_flow(nodes, edges, demands, r.flows))
        self.assertTrue(verify_optimality(nodes, edges, demands,
                                          r.flows, r.potentials))

    def test_tampered_flow_out_of_bounds(self):
        nodes, edges, demands, r = solved()
        bad = dict(r.flows)
        bad["sa"] = 99  # exceeds hi
        self.assertFalse(verify_flow(nodes, edges, demands, bad))
        self.assertFalse(verify_optimality(nodes, edges, demands,
                                           bad, r.potentials))

    def test_tampered_flow_imbalance(self):
        nodes, edges, demands, r = solved()
        bad = dict(r.flows)
        bad["at"] = bad["at"] - 1  # breaks balance at A and T
        self.assertFalse(verify_flow(nodes, edges, demands, bad))

    def test_tampered_flow_missing_edge(self):
        nodes, edges, demands, r = solved()
        bad = dict(r.flows)
        del bad["st"]
        self.assertFalse(verify_flow(nodes, edges, demands, bad))

    def test_tampered_potentials(self):
        nodes, edges, demands, r = solved()
        bad = dict(r.potentials)
        bad["T"] = bad["T"] + 50  # breaks reduced-cost conditions
        self.assertFalse(verify_optimality(nodes, edges, demands,
                                           r.flows, bad))
        bad2 = dict(r.potentials)
        del bad2["A"]
        self.assertFalse(verify_optimality(nodes, edges, demands,
                                           r.flows, bad2))

    def test_suboptimal_flow_rejected_by_optimality(self):
        nodes, edges, demands, r = solved()
        # force flow onto the expensive direct edge: feasible, not optimal
        sub = {"sa": 2, "at": 2, "st": 1}
        self.assertTrue(verify_flow(nodes, edges, demands, sub))
        self.assertFalse(verify_optimality(nodes, edges, demands,
                                           sub, r.potentials))

    def test_cut_certificate_and_tampering(self):
        nodes = ["A", "B", "C"]
        edges = [
            Edge("ab", "A", "B", 0, 2, 1),
            Edge("bc", "B", "C", 0, 2, 1),
        ]
        demands = {"A": -5, "C": 5}
        s = MinCostCirculation(nodes, edges, demands)
        r = s.solve()
        self.assertEqual(r.feasibility, "infeasible")
        self.assertTrue(verify_cut(nodes, edges, demands, r.certificate))
        # tampered certificates must be rejected
        self.assertFalse(verify_cut(nodes, edges, demands, ["A"]))
        self.assertFalse(verify_cut(nodes, edges, demands, []))
        self.assertFalse(verify_cut(nodes, edges, demands, ["A", "ghost"]))
        self.assertFalse(verify_cut(nodes, edges, demands, "not-a-set"))
        # a certificate for a *feasible* instance must not validate
        ok_edges = [Edge("ab", "A", "B", 0, 9, 1), Edge("bc", "B", "C", 0, 9, 1)]
        self.assertFalse(verify_cut(nodes, ok_edges, demands, r.certificate))


if __name__ == "__main__":
    unittest.main()
