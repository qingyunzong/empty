import inspect
import unittest

import mcflow.verifier
from mcflow import compute_potentials, verify
from helpers import diamond_network, negative_cycle_network


def optimal_certificate(network):
    flows = {"e1": 3, "e2": 3, "e3": 0}
    return {
        "flows": flows,
        "potentials": compute_potentials(network, flows),
        "declared_cost": 6,
    }


class VerifierTest(unittest.TestCase):
    def test_valid_optimal_certificate_passes(self):
        network = diamond_network()
        report = verify(network, optimal_certificate(network))
        self.assertTrue(report.ok, report.violations)
        self.assertEqual(report.violations, [])

    def test_capacity_violation_reports_edge(self):
        network = diamond_network()
        cert = optimal_certificate(network)
        cert["flows"] = {"e1": 5, "e2": 3, "e3": 0}  # e1 upper is 4
        cert["declared_cost"] = 8
        report = verify(network, cert)
        capacity = [v for v in report.violations if v["type"] == "capacity"]
        self.assertFalse(report.ok)
        self.assertEqual(len(capacity), 1)
        self.assertEqual(capacity[0]["edge"], "e1")
        self.assertEqual(capacity[0]["flow"], 5)
        self.assertEqual(capacity[0]["upper"], 4)

    def test_conservation_violation_reports_node(self):
        network = diamond_network()
        cert = optimal_certificate(network)
        cert["flows"] = {"e1": 3, "e2": 2, "e3": 0}  # node a unbalanced
        cert["declared_cost"] = 5
        report = verify(network, cert)
        conservation = [v for v in report.violations if v["type"] == "conservation"]
        nodes = {v["node"] for v in conservation}
        self.assertIn("a", nodes)
        self.assertIn("t", nodes)
        for v in conservation:
            if v["node"] == "a":
                self.assertEqual(v["demand"], 0)
                self.assertEqual(v["actual"], 1)

    def test_tampered_declared_cost(self):
        network = diamond_network()
        cert = optimal_certificate(network)
        cert["declared_cost"] = 7
        report = verify(network, cert)
        mismatch = [v for v in report.violations if v["type"] == "cost_mismatch"]
        self.assertEqual(len(mismatch), 1)
        self.assertEqual(mismatch[0]["declared"], 7)
        self.assertEqual(mismatch[0]["actual"], 6)

    def test_tampered_potentials_flag_reduced_cost(self):
        network = diamond_network()
        cert = optimal_certificate(network)
        cert["potentials"]["t"] += 10  # break reduced costs on e2/e3
        report = verify(network, cert)
        reduced = [v for v in report.violations if v["type"] == "reduced_cost"]
        self.assertFalse(report.ok)
        self.assertTrue(reduced)
        edges = {(v["edge"], v["direction"]) for v in reduced}
        self.assertIn(("e2", "forward"), edges)
        self.assertIn(("e3", "forward"), edges)
        # Flow is still optimal: no genuine negative cycle may be reported.
        self.assertEqual([v for v in report.violations
                          if v["type"] == "negative_cycle"], [])

    def test_feasible_but_suboptimal_flow_reports_negative_cycle(self):
        network = diamond_network()
        # Conserves flow and respects capacities, but routes everything over
        # the expensive direct edge: not cost-optimal.
        cert = {
            "flows": {"e1": 0, "e2": 0, "e3": 3},
            "potentials": {"s": 0, "a": 0, "t": 0},
            "declared_cost": 15,
        }
        report = verify(network, cert)
        self.assertFalse(report.ok)
        self.assertEqual([v for v in report.violations
                          if v["type"] in ("capacity", "conservation",
                                           "cost_mismatch")], [])
        cycles = [v for v in report.violations if v["type"] == "negative_cycle"]
        self.assertEqual(len(cycles), 1)
        self.assertEqual(cycles[0]["total_cost"], -3)  # 1 + 1 - 5
        arcs = {(a["edge"], a["direction"]) for a in cycles[0]["arcs"]}
        self.assertEqual(arcs, {("e1", "forward"), ("e2", "forward"),
                                ("e3", "backward")})

    def test_negative_cost_cycle_reported(self):
        network = negative_cycle_network()
        cert = {
            "flows": {"e1": 0, "e2": 0},
            "potentials": {"x": 0, "y": 0},
            "declared_cost": 0,
        }
        report = verify(network, cert)
        cycles = [v for v in report.violations if v["type"] == "negative_cycle"]
        self.assertEqual(len(cycles), 1)
        self.assertEqual(cycles[0]["total_cost"], -3)
        reduced = [v for v in report.violations if v["type"] == "reduced_cost"]
        self.assertEqual({(v["edge"], v["direction"]) for v in reduced},
                         {("e1", "forward"), ("e2", "forward")})

    def test_missing_flow_edge_reported(self):
        network = diamond_network()
        cert = optimal_certificate(network)
        del cert["flows"]["e2"]
        report = verify(network, cert)
        missing = [v for v in report.violations if v["type"] == "missing_flow"]
        self.assertEqual([v["edge"] for v in missing], ["e2"])

    def test_batch_validation_no_contamination(self):
        network = diamond_network()
        before = network.to_dict()
        bad = {
            "flows": {"e1": 99, "e2": -4, "e3": 2},
            "potentials": {"s": 100, "a": -100, "t": 7},
            "declared_cost": -12345,
        }
        bad_report = verify(network, bad)
        self.assertFalse(bad_report.ok)
        good_report = verify(network, optimal_certificate(network))
        self.assertTrue(good_report.ok, good_report.violations)
        # The shared network object must be untouched by the bad certificate.
        self.assertEqual(network.to_dict(), before)
        # Re-validating the bad certificate must reproduce the same result.
        self.assertEqual(verify(network, bad).to_dict(), bad_report.to_dict())

    def test_verifier_is_independent_of_repairer(self):
        source = inspect.getsource(mcflow.verifier)
        imports = [line for line in source.splitlines()
                   if line.startswith(("import ", "from "))]
        self.assertFalse(any("repairer" in line for line in imports),
                         imports)


if __name__ == "__main__":
    unittest.main()
